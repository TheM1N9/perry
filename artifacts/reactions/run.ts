import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Failure cases and the native API limitations are documented in README.md.
const out = resolve("artifacts/reactions");
const home = resolve("node_modules/.cache/perry-reactions", `run-${Date.now()}`);
mkdirSync(home, { recursive: true });
process.env.PERRY_HOME = home;
process.env.PERRY_WHATSAPP_DRIVER = resolve("artifacts/reactions/driver.mjs");
process.env.DASHBOARD_KEY = "reactions-fixture";
process.env.PERRY_CREDENTIAL_KEY = "77".repeat(32);
process.env.PERRY_EMBED_MODEL = "reactions-fixture";
process.env.TELEGRAM_BOT_TOKEN = "123456:reactions-fixture";
process.env.TELEGRAM_API_BASE = "http://telegram.fixture";
const embeddings = globalThis as typeof globalThis & {
  __perryEmbedders?: Map<string, Promise<(texts: string[]) => Promise<number[][]>>>;
  __perryEmbeddersReady?: Set<string>;
};
embeddings.__perryEmbedders = new Map([["reactions-fixture", Promise.resolve(async (texts: string[]) => texts.map(() => [1, 0]))]]);
embeddings.__perryEmbeddersReady = new Set(["reactions-fixture"]);
const telegram: Array<{ method: string; body: Record<string, unknown> }> = [];
let nextTelegramId = 1000;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assert.equal(url.origin, "http://telegram.fixture", "Real network requests are forbidden");
  const method = url.pathname.split("/").at(-1)!;
  const body = JSON.parse(String(options?.body ?? "{}")) as Record<string, unknown>;
  telegram.push({ method, body });
  if (method === "setMessageReaction" && JSON.stringify(body).includes("UNSUPPORTED")) return Response.json({ ok: false, error_code: 400, description: "REACTION_INVALID" });
  return Response.json({ ok: true, result: { message_id: nextTelegramId++ } });
};
const checks: string[] = [];
const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
async function until(test: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!test()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await new Promise(done => setTimeout(done, 10));
  }
}
let runtime: import("../../server/runtime").Runtime | undefined;
let sql: DatabaseSync | undefined;
let stopWhatsApp: (() => Promise<void>) | undefined;
let failure: string | undefined;
let waSent: unknown[] = [];
try {
  const [{ Runtime }, { default: schema }, { modules }, { default: http }, { runWhatsApp }, driver] = await Promise.all([
    import("../../server/runtime"), import("../../convex/schema"), import("../../server/modules"), import("../../convex/http"), import("../../server/whatsapp"), import("./driver.mjs"),
  ]);
  waSent = driver.sent;
  sql = new DatabaseSync(join(home, "fixture.sqlite"));
  runtime = new Runtime(sql, schema as never, modules, { storageDir: join(home, "storage"), http: http as never });
  const rt = runtime;
  await rt.stop();
  const db = rt.store;
  const token = "reactions-runner";
  const wa = "919876543210@s.whatsapp.net";
  const tg = "4242";
  const call = async <T = unknown>(name: string, args: object = {}) => (await rt.call(name, args, { internal: true })).value as T;
  const install = db.insert("installation", { defaultEngine: "codex", onboarding: "skipped", timezone: "Asia/Kolkata", claimedAt: Date.now(), ownerChannel: "telegram", ownerExternalId: tg, whatsappOwner: wa, createdAt: Date.now() });
  db.insert("whatsappLink", { wanted: true, mode: "self", status: "connected", me: wa, updatedAt: Date.now() });
  db.insert("runners", { name: "Fixture", token, createdAt: Date.now(), lastSeenAt: Date.now(), engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: Date.now() }] });
  const scheduled = () => sql!.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn' ORDER BY createdAt DESC").all()
    .map(row => JSON.parse(String(row.args)) as { channel: string; externalId: string; text: string; reactionEvent?: boolean; outside?: boolean });
  async function prepare(args: object) {
    await call("brain:handleTurn", args);
    const prompt = (args as { text: string }).text;
    const turn = db.all("codexTurns").find(row => row.prompt === prompt && row.status === "queued");
    assert(turn);
    assert(await call("codex:claimTurn", { token, id: turn._id }));
    return turn;
  }
  async function mcp(chat: string, emoji: string, messageId?: string) {
    const response = await rt.runHttp("/mcp", new Request("http://fixture/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "x-perry-chat": chat }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "react_to_message", arguments: { emoji, ...(messageId ? { messageId } : {}) } } }) }));
    const rpc = await response.json() as { error?: unknown; result?: { content?: Array<{ text: string }> } };
    const text = rpc.result?.content?.[0]?.text;
    return text?.startsWith("{") ? JSON.parse(text) as { status?: string; error?: string; messageId?: string } : { error: JSON.stringify(rpc) };
  }
  async function finish(id: string, response = "NO_REPLY") {
    await call("codex:finishTurn", { token, id, response });
    await call("codex:finalizeTurn", { id });
  }
  const textCalls = () => telegram.filter(row => ["sendMessage", "editMessageText"].includes(row.method));
  stopWhatsApp = runWhatsApp(rt);
  await until(() => Boolean(driver.socket?.ev.listenerCount("messages.reaction")), "WhatsApp listeners");
  driver.socket.ev.emit("messages.upsert", { type: "notify", messages: [{ key: { id: "owner-1", remoteJid: wa, fromMe: true }, message: { conversation: "Please work on this quietly." } }] });
  await until(() => scheduled().some(row => row.channel === "whatsapp"), "WhatsApp inbound");
  const waTurn = await prepare(scheduled().find(row => row.channel === "whatsapp")!);
  const waChat = String(waTurn.conversationId);
  assert(String(waTurn.recalled).includes("owner-1"));
  assert.equal((await mcp(waChat, "👀")).status, "queued");
  await until(() => driver.sent.some(row => row.content.react?.text === "👀"), "native eyes reaction");
  const afterSeen = scheduled().length;
  assert.equal((await mcp(waChat, "🤔", "owner-1")).status, "queued");
  assert.equal((await mcp(waChat, "🎉", "owner-1")).status, "queued");
  assert.equal((await mcp(waChat, "", "owner-1")).status, "queued");
  await until(() => driver.sent.some(row => row.content.react?.text === ""), "reaction removal");
  assert.equal(scheduled().length, afterSeen, "Our synchronous self-chat echoes must not create turns");
  assert(driver.sent.filter(row => row.content.react).every(row => row.to === wa && row.content.react.key.id === "owner-1"));
  pass("WhatsApp native reactions can change freely and be removed, without self-chat echo turns");
  await finish(waTurn._id);
  assert.equal(db.get(waTurn._id)?.status, "done");
  assert.equal(db.get(waTurn._id)?.reactionOnly, true);
  assert(!driver.sent.some(row => row.content.text));
  assert(!db.all("agentMessages").some(row => row.text === "NO_REPLY"));
  pass("a successful reaction-only turn ends normally without extra text or a sentinel");

  const web = await call<string>("dashboard:createChat", { key: process.env.DASHBOARD_KEY });
  assert.equal((await call<{ status: string }>("notify:sendToOwner", { from: web, channel: "whatsapp", text: "The morning train is option two.", context: "We compared trains within a budget of 60." })).status, "queued");
  await until(() => driver.sent.some(row => row.content.text), "outgoing WhatsApp receipt");
  const outgoing = driver.sent.find(row => row.content.text)!;
  const feedback = (id: string, emoji: string, at: number, remote = wa) => {
    driver.socket.ev.emit("messages.upsert", { type: "notify", messages: [{ key: { id, remoteJid: remote, fromMe: true }, message: { reactionMessage: { key: { id: outgoing.id, fromMe: true, remoteJid: remote }, text: emoji } } }] });
    driver.socket.ev.emit("messages.reaction", [{ key: { id: outgoing.id, fromMe: true }, reaction: { key: { id, remoteJid: remote, fromMe: true }, text: emoji, senderTimestampMs: at } }]);
  };
  const beforeFeedback = scheduled().length;
  feedback("feedback-1", "❤️", 2000);
  await until(() => scheduled().length === beforeFeedback + 1, "owner reaction context");
  assert(scheduled()[0].text.includes("morning train"));
  feedback("feedback-duplicate", "❤️", 3000);
  feedback("feedback-stale", "👎", 2500);
  feedback("feedback-stranger", "👎", 3000, "stranger@s.whatsapp.net");
  await new Promise(done => setTimeout(done, 30));
  assert.equal(scheduled().length, beforeFeedback + 1);
  feedback("feedback-change", "👎", 4000);
  await until(() => scheduled().length === beforeFeedback + 2, "changed feedback");
  feedback("feedback-remove", "", 5000);
  await until(() => scheduled().length === beforeFeedback + 3, "removed feedback");
  const reactionTurn = await prepare(scheduled()[0]);
  assert.equal(reactionTurn.reactionEvent, true);
  assert.equal(await call<boolean>("codex:outwardAllowed", { turnId: reactionTurn._id }), false);
  assert(scheduled()[0].text.includes("never approval"));
  await finish(reactionTurn._id);
  assert.equal(db.get(reactionTurn._id)?.reactionOnly, true);
  pass("owner feedback includes its message, changes and removals, without duplicates, strangers or approval escalation");

  async function telegramTurn(id: number, text: string) {
    await call("ingest:fromTelegram", { update: { update_id: id, message: { message_id: id, date: 100, chat: { id: Number(tg), type: "private" }, from: { id: Number(tg), is_bot: false }, text } } });
    return await prepare(scheduled().find(row => row.text === text)!);
  }
  const tgTurn = await telegramTurn(101, "Use a reaction here too.");
  const tgChat = String(tgTurn.conversationId);
  assert.equal((await mcp(tgChat, "👀")).status, "sent");
  assert.equal((await mcp(tgChat, "🔥", "101")).status, "sent");
  assert.equal((await mcp(tgChat, "", "101")).status, "sent");
  const reactionCalls = telegram.filter(row => row.method === "setMessageReaction");
  assert.equal(reactionCalls.length, 3);
  assert(reactionCalls.every(row => row.body.chat_id === tg && row.body.message_id === 101));
  assert.deepEqual(reactionCalls.at(-1)!.body.reaction, []);
  const beforeQuiet = textCalls().length;
  await call("codex:streamTurn", { token, id: tgTurn._id, text: "NO_REPLY" });
  await call("codex:streamToTelegram", { id: tgTurn._id });
  await finish(tgTurn._id);
  assert.equal(textCalls().length, beforeQuiet);
  assert.equal(db.get(tgTurn._id)?.status, "done");
  pass("Telegram replaces and removes one native reaction, and never streams or sends NO_REPLY");

  const failedTurn = await telegramTurn(102, "A rejected reaction still needs an answer.");
  assert.equal((await mcp(tgChat, "UNSUPPORTED", "102")).status, "failed");
  await finish(failedTurn._id);
  assert.equal(db.get(failedTurn._id)?.errorCode, "empty_reply");
  assert.notEqual(db.get(failedTurn._id)?.reactionOnly, true);
  pass("a failed reaction cannot hide an unanswered request as a reaction-only success");

  await call("notify:sendToOwner", { from: web, channel: "telegram", text: "Here is the selected train.", context: "Option two is the morning train." });
  const receipt = db.all("channelMessages").find(row => row.channel === "telegram" && row.isPerry === true && String(row.text).includes("selected train"));
  assert(receipt);
  const beforeTelegramFeedback = scheduled().length;
  const reactionUpdate = (user: number) => ({ update: { update_id: 10000, message_reaction: { chat: { id: Number(tg) }, message_id: Number(receipt.messageId), user: { id: user, is_bot: false }, date: 12345, old_reaction: [], new_reaction: [{ type: "emoji", emoji: "❤️" }] } } });
  await call("ingest:fromTelegram", reactionUpdate(9999));
  assert.equal(scheduled().length, beforeTelegramFeedback);
  await call("ingest:fromTelegram", reactionUpdate(Number(tg)));
  assert.equal(scheduled().length, beforeTelegramFeedback + 1);
  assert(scheduled()[0].text.includes("selected train"));
  assert.equal(db.all("approvals").length, 0);
  pass("Telegram-delivered owner reactions carry exact message context and never act as approval");

  const draftTurn = await telegramTurn(103, "Finish with a reaction instead of a draft.");
  await call("codex:streamTurn", { token, id: draftTurn._id, text: "Working on this" });
  await call("codex:streamToTelegram", { id: draftTurn._id });
  await mcp(tgChat, "👍", "103");
  await finish(draftTurn._id);
  assert(telegram.some(row => row.method === "deleteMessage"));
  pass("reaction-only completion removes an unfinished Telegram streamed draft");

  const guardTurn = await telegramTurn(104, "Only this phone chat may react.");
  const count = telegram.filter(row => row.method === "setMessageReaction").length;
  assert.equal((await mcp(tgChat, "👍", "owner-1")).status, "failed");
  db.patch(guardTurn._id, { stopRequested: true });
  assert((await mcp(tgChat, "👍", "104")).error);
  assert.equal(telegram.filter(row => row.method === "setMessageReaction").length, count);
  const beforeRows = db.all("channelMessages").length;
  await call("reactions:record", { channel: "telegram", externalId: tg, messageId: "104", text: "Updated source", isPerry: false });
  assert.equal(db.all("channelMessages").length, beforeRows);
  db.patch(receipt._id, { createdAt: Date.now() - 15 * 86_400_000 });
  await call("reactions:record", { channel: "telegram", externalId: tg, messageId: "105", text: "Receipt cleanup", isPerry: false });
  assert.equal(db.get(receipt._id), null);
  db.patch(install, { paused: { at: Date.now(), by: "web" } });
  assert((await mcp(tgChat, "👍", "104")).error);
  pass("targets are chat-scoped, stopped or paused calls cannot react, and receipts replace and expire");

  await stopWhatsApp();
  stopWhatsApp = undefined;
  assert.equal(driver.socket.ev.eventNames().length, 0);
  pass("stopping the WhatsApp connection removes the native fixture listeners");
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
} finally {
  await stopWhatsApp?.();
  await runtime?.stop();
  sql?.close();
  globalThis.fetch = realFetch;
  embeddings.__perryEmbedders?.clear();
  embeddings.__perryEmbeddersReady?.clear();
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "result.json"), JSON.stringify({ passed: !failure, checks, failure, model: "fixture responses; native transports are stand-ins", telegramIncoming: "Only events delivered under Telegram's administrator-permission contract are covered." }, null, 2) + "\n");
  writeFileSync(join(out, "transports.json"), JSON.stringify({ telegram, whatsapp: waSent }, null, 2) + "\n");
}
if (failure) process.exitCode = 1;
