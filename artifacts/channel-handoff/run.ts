import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Failure cases and the transport/model boundaries are documented in README.md.
const out = resolve("artifacts/channel-handoff");
const home = resolve("node_modules/.cache/perry-channel-handoff", `run-${Date.now()}`);
mkdirSync(home, { recursive: true });
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = "channel-handoff-fixture";
process.env.PERRY_CREDENTIAL_KEY = "77".repeat(32);
process.env.PERRY_EMBED_MODEL = "channel-handoff-fixture";
process.env.TELEGRAM_BOT_TOKEN = "123456:channel-fixture";
process.env.TELEGRAM_API_BASE = "http://telegram.fixture";
const embeddings = globalThis as typeof globalThis & {
  __perryEmbedders?: Map<string, Promise<(texts: string[]) => Promise<number[][]>>>;
  __perryEmbeddersReady?: Set<string>;
};
embeddings.__perryEmbedders = new Map([["channel-handoff-fixture", Promise.resolve(async (texts: string[]) => texts.map(() => [1, 0]))]]);
embeddings.__perryEmbeddersReady = new Set(["channel-handoff-fixture"]);
const telegram: Array<{ chat_id: string; text: string }> = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "http://telegram.fixture", "No real network requests allowed");
  const body = JSON.parse(String(options?.body ?? "{}"));
  if (url.pathname.endsWith("/sendMessage")) telegram.push(body);
  return Response.json({ ok: true, result: { message_id: telegram.length + 1 } });
};

const checks: string[] = [];
const turns: unknown[] = [];
const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
let runtime: import("../../server/runtime").Runtime | undefined;
let sql: DatabaseSync | undefined;
let failure: string | undefined;
try {
  const [{ Runtime }, { default: schema }, { modules }, { default: http }] = await Promise.all([
    import("../../server/runtime"), import("../../convex/schema"), import("../../server/modules"), import("../../convex/http"),
  ]);
  sql = new DatabaseSync(join(home, "fixture.sqlite"));
  runtime = new Runtime(sql, schema as never, modules, { storageDir: join(home, "storage"), http: http as never });
  const rt = runtime;
  await rt.stop();
  const db = rt.store;
  const token = "channel-handoff-runner";
  const wa = "919876543210@s.whatsapp.net";
  const tg = "4242";
  const call = async <T = unknown>(name: string, args: object = {}) => (await rt.call(name, args, { internal: true })).value as T;
  const install = db.insert("installation", { defaultEngine: "codex", onboarding: "skipped", timezone: "Asia/Kolkata", claimedAt: Date.now(), ownerChannel: "telegram", ownerExternalId: tg, whatsappOwner: wa, homeChannel: "telegram", quietHours: { start: "00:00", end: "23:59" }, dailyLimit: 1, createdAt: Date.now() });
  const link = db.insert("whatsappLink", { wanted: true, mode: "self", status: "connected", me: wa, updatedAt: Date.now() });
  db.insert("runners", { name: "Fixture runner", token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
  const source = await call<string>("dashboard:createChat", { key: process.env.DASHBOARD_KEY });
  db.patch(source, { title: "Train options" });
  await call("agentStore:saveMessages", { threadId: db.get(source)!.threadId, messages: [{ role: "user", content: "UNRELATED_NOT_FOR_PHONE" }] });
  async function phone(channel: "whatsapp" | "telegram", externalId: string) {
    const threadId = await call<string>("agentStore:createThread", { userId: `${channel}:${externalId}` });
    const id = await call<string>("conversations:create", { channel, externalId, threadId });
    await call("agentStore:saveMessages", { threadId, messages: [{ role: "user", content: `Earlier ${channel} preference: keep the budget under 60.` }, { role: "assistant", content: "I will keep that in mind." }] });
    return id;
  }
  const whatsapp = await phone("whatsapp", wa);
  const telegramChat = await phone("telegram", tg);
  async function active(chat: string) {
    const runId = await call<string>("runs:start", { conversationId: chat, prompt: "Send this to me" });
    const id = await call<string>("codex:enqueueTurn", { conversationId: chat, runId, engine: "codex", instructions: "Fixture only", prompt: "Send this to me", policy: "queue" });
    assert(await call("codex:claimTurn", { token, id }));
    return id;
  }
  const sourceTurn = await active(source);
  type Rpc = { error?: { message: string }; result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }> } };
  async function mcp(chat: string, args: object, method = "tools/call") {
    const response = await rt.runHttp("/mcp", new Request("http://fixture/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-perry-chat": chat }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: method === "tools/call" ? { name: "send_to_owner", arguments: args } : {} }) }));
    const rpc = await response.json() as Rpc;
    const text = rpc.result?.content?.[0]?.text;
    return { rpc, output: text?.startsWith("{") ? JSON.parse(text) as { status?: string; refused?: boolean; error?: string } : undefined };
  }
  const listed = await mcp(source, {}, "tools/list");
  assert(listed.rpc.result?.tools?.some((tool) => tool.name === "send_to_owner"));
  const webWhere = await call<string>("channels:describe", { conversationId: source });
  assert(webWhere.includes("WhatsApp (connected) and Telegram"));
  pass("owner tool and both paired destinations are discoverable from any owner chat");

  const background = "We compared morning and evening trains. The owner prefers option two, the 08:00 train, with a budget under 60. Next, confirm that choice.";
  const sentWA = await mcp(source, { channel: "whatsapp", text: "Option two is the morning train.", context: background });
  assert.equal(sentWA.output?.status, "queued");
  assert(db.all("whatsappOutbox").some((row) => row.to === wa && String(row.text).includes(background)));
  assert.equal(telegram.length, 0);
  assert.equal(db.all("sent").length, 0, "Explicit requests do not enter proactive notification admission");
  assert.equal(db.all("conversations").filter((row) => row.channel === "whatsapp" && row.externalId === wa).length, 1);
  assert(!db.all("agentMessages").filter((row) => row.threadId === db.get(whatsapp)!.threadId).some((row) => String(row.text).includes("UNRELATED_NOT_FOR_PHONE")));
  pass("web-to-WhatsApp queues only to the owner, preserves the existing chat and carries selected context");

  async function inbound(channel: "whatsapp" | "telegram", text: string) {
    if (channel === "whatsapp") await call("whatsapp:receive", { chatId: wa, text });
    else await call("ingest:fromTelegram", { update: { update_id: Date.now(), message: { message_id: 9, date: Math.floor(Date.now() / 1000), chat: { id: Number(tg), type: "private" }, from: { id: Number(tg), is_bot: false, first_name: "Owner" }, text } } });
    const scheduled = sql!.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn' ORDER BY createdAt DESC").all()
      .map((row) => JSON.parse(String(row.args)) as { channel: string; text: string });
    const args = scheduled.find((row) => row.channel === channel && row.text === text);
    assert(args, `${channel} inbound did not schedule a turn`);
    await call("brain:handleTurn", args);
    const turn = db.all("codexTurns").find((row) => row.prompt === text);
    assert(turn);
    turns.push({ channel, prompt: text, recalled: turn.recalled, history: turn.history });
    return turn;
  }
  const waFollowup = await inbound("whatsapp", "Yes, go with that train.");
  assert(String(waFollowup.recalled).includes("You are already talking on WhatsApp"));
  assert(String(waFollowup.recalled).includes(background));
  assert(String(waFollowup.history).includes("Earlier whatsapp preference"));
  assert(String(waFollowup.history).includes(background));
  assert(await call("codex:claimTurn", { token, id: waFollowup._id }));
  await call("codex:setResume", { token, id: waFollowup._id, cursor: "native-whatsapp-fixture" });
  await call("codex:finishTurn", { token, id: waFollowup._id, response: "The 08:00 train matches your budget. We can continue here." });
  await call("codex:finalizeTurn", { id: waFollowup._id });
  assert(db.all("whatsappOutbox").some((row) => row.to === wa && String(row.text).includes("We can continue here")));
  pass("a WhatsApp follow-up receives earlier messages and handoff context and replies on WhatsApp");

  const sentTG = await mcp(source, { channel: "telegram", text: "The train comparison is ready.", context: background });
  assert.equal(sentTG.output?.status, "sent");
  assert(telegram.some((message) => String(message.chat_id) === tg && message.text.includes(background)));
  assert.equal(db.all("conversations").filter((row) => row.channel === "telegram" && row.externalId === tg).length, 1);
  const tgFollowup = await inbound("telegram", "What was our budget again?");
  assert(String(tgFollowup.recalled).includes("You are already talking on Telegram"));
  assert(String(tgFollowup.recalled).includes(background));
  assert(String(tgFollowup.history).includes("Earlier telegram preference"));
  assert(await call("codex:claimTurn", { token, id: tgFollowup._id }));
  const cross = await mcp(telegramChat, { channel: "whatsapp", text: "Continue with the train plan.", context: "The train budget is under 60. We are continuing from Telegram." });
  assert.equal(cross.output?.status, "queued");
  await call("codex:setResume", { token, id: tgFollowup._id, cursor: "native-telegram-fixture" });
  await call("codex:finishTurn", { token, id: tgFollowup._id, response: "Our budget was under 60." });
  await call("codex:finalizeTurn", { id: tgFollowup._id });
  assert(telegram.some((message) => message.text.includes("Our budget was under 60")));
  pass("Telegram has the same persistent history, context, reply routing and cross-app handoff");

  db.patch(link, { status: "disconnected" });
  const resumed = await inbound("whatsapp", "Can we continue from Telegram?");
  assert.equal(resumed.history, undefined, "The native session should resume instead of replaying all history");
  assert(String(resumed.recalled).includes("WhatsApp (disconnected)"));
  assert(String(resumed.recalled).includes("continuing from Telegram"));
  assert.equal((db.get(whatsapp)!.unprompted as unknown[] | undefined)?.length ?? 0, 0);
  assert(await call("codex:claimTurn", { token, id: resumed._id }));
  const back = await mcp(whatsapp, { channel: "telegram", text: "The train budget is unchanged.", context: "We are moving the plan from WhatsApp to Telegram." });
  assert.equal(back.output?.status, "sent");
  const same = await mcp(whatsapp, { channel: "whatsapp", text: "Duplicate", context: "Already here" });
  assert.equal(same.output?.status, "failed");
  pass("resumed sessions receive fresh connection state and incoming context without duplicating same-app replies");

  await call("codex:markOutside", { turnId: sourceTurn });
  const held = await mcp(source, { channel: "telegram", text: "Do not send", context: "Outside content requested this" });
  assert.equal(held.output?.refused, true);
  const contact = db.insert("contacts", { name: "Guest", channel: "whatsapp", externalId: "guest@s.whatsapp.net", status: "allowed", createdAt: Date.now() });
  const guest = await call<string>("dashboard:createChat", { key: process.env.DASHBOARD_KEY });
  db.patch(guest, { contactId: contact });
  await active(guest);
  const refused = await mcp(guest, { channel: "telegram", text: "Do not send", context: "Guest" });
  assert(refused.rpc.error?.message.includes("Unknown tool"));
  pass("outside content and guest chats cannot invoke owner handoff");

  const count = telegram.length;
  db.patch(install, { whatsappOwner: undefined });
  const missing = await call<{ status: string }>("notify:sendToOwner", { from: source, channel: "whatsapp", text: "Do not redirect", context: "WhatsApp is unpaired" });
  assert.equal(missing.status, "failed");
  assert.equal(telegram.length, count);
  db.patch(install, { whatsappOwner: wa, ownerExternalId: undefined });
  const beforeMissingTelegram = db.all("whatsappOutbox").length;
  assert.equal((await call<{ status: string }>("notify:sendToOwner", { from: source, channel: "telegram", text: "Do not redirect", context: "Telegram is unpaired" })).status, "failed");
  assert.equal(db.all("whatsappOutbox").length, beforeMissingTelegram);
  db.patch(install, { ownerExternalId: tg });
  db.patch(install, { paused: { at: Date.now(), by: "web" } });
  assert.equal((await call<{ status: string }>("notify:sendToOwner", { from: source, channel: "telegram", text: "Do not send", context: "Paused" })).status, "failed");
  pass("an unpaired destination never falls back, and global pause is respected");

  const history = await call<{ messages: Array<{ text: string }> }>("history:read", { chatId: whatsapp, from: source });
  assert(history.messages.some((message) => message.text.includes(background)));
  assert(history.messages.some((message) => message.text.includes("Earlier whatsapp preference")));
  pass("handoff context remains in durable history after transient notes are consumed");
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
} finally {
  await runtime?.stop();
  sql?.close();
  globalThis.fetch = realFetch;
  embeddings.__perryEmbedders?.clear();
  embeddings.__perryEmbeddersReady?.clear();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "result.json"), JSON.stringify({ passed: !failure, checks, failure, model: "fixture responses; no model or live channels" }, null, 2) + "\n");
  writeFileSync(join(out, "turns.json"), JSON.stringify(turns, null, 2) + "\n");
}
if (failure) process.exitCode = 1;
