// Failure inventory: failure-cases.md. Real backend/SQLite and runner claims, with the
// scheduler stopped, synthetic data, and Telegram's API replaced by a local recorder.
// pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/guest-reactions/run.mjs <outDir>
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";

if (!process.argv[2]) throw new Error("Pass a disposable output directory");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const report = { checkedAt: new Date().toISOString(), passed: false, cases: [] };
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
const scratch = mkdtempSync(join(tmpdir(), "perry-guest-reactions-"));
process.env.PERRY_HOME = scratch;
process.env.DASHBOARD_KEY = "synthetic-guest-reactions-key";
process.env.PERRY_CREDENTIAL_KEY = "36".repeat(32);
process.env.TELEGRAM_BOT_TOKEN = "999:synthetic";
const telegram = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const method = String(url).match(/\/bot[^/]+\/(\w+)$/)?.[1];
  if (!method) throw new Error(`External IO disabled for guest-reaction replay: ${url}`);
  telegram.push({ method, body: init?.body ? JSON.parse(init.body) : {} });
  const result = method === "getMe" ? { id: 999, username: "perry_bot", is_bot: true } : method === "sendMessage" ? { message_id: 5000 + telegram.length } : true;
  return new Response(JSON.stringify({ ok: true, result }), { headers: { "content-type": "application/json" } });
};
const [{ Runtime }, { default: schema }, { modules }, { GUEST_TOOLS }] = await Promise.all([
  import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"), import("../../convex/lib/engines.ts"),
]);
const sql = new DatabaseSync(":memory:");
const runtime = new Runtime(sql, schema, modules, { storageDir: join(scratch, "storage") });
await runtime.stop();
const call = async (name, args = {}) => (await runtime.call(name, args, { internal: true })).value;
const insert = (table, doc) => runtime.exclusive(() => runtime.store.insert(table, doc));
const get = id => runtime.exclusive(() => runtime.store.get(id));
const patch = (id, doc) => runtime.exclusive(() => runtime.store.patch(id, doc));
const all = table => runtime.exclusive(() => runtime.store.query(table).collect());
const token = "synthetic-guest-reactions-runner";
const OWNER = "100@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const MEMBER = "200@s.whatsapp.net";
const PERSON = "300@s.whatsapp.net";
const TG_GROUP = "-1001234";

const chatOf = async (channel, externalId) => (await all("conversations")).find(row => row.channel === channel && row.externalId === externalId);
const turnsOf = async conversationId => (await all("codexTurns")).filter(row => row.conversationId === conversationId).sort((a, b) => a.createdAt - b.createdAt);
const scheduledTurns = () => sql.prepare("SELECT args FROM _scheduled WHERE name = 'brain:handleTurn'").all().map(row => JSON.parse(row.args));
const reactionsTo = to => all("whatsappOutbox").then(rows => rows.filter(row => row.kind === "reaction" && row.to === to));
const telegramReactions = () => telegram.filter(item => item.method === "setMessageReaction");
/** The newest turn in a chat, claimed by the runner as it would be: running, so it may react. */
const claimLatest = async (channel, externalId) => {
  const chat = await chatOf(channel, externalId);
  assert.ok(chat, `a chat with ${externalId} must exist`);
  const queued = (await turnsOf(chat._id)).filter(turn => turn.status === "queued");
  assert.equal(queued.length, 1, "exactly one turn must be queued");
  const claimed = await call("codex:claimTurn", { token, id: queued[0]._id });
  assert.ok(claimed, "runner must claim the turn");
  return claimed;
};
const finish = id => patch(id, { status: "done", finishedAt: Date.now(), finalizedAt: Date.now() });
const react = (turnId, emoji, messageId) => call("reactions:react", { turnId, emoji, ...(messageId ? { messageId } : {}) });
const groupMessage = (id, text, extra = {}) => call("whatsapp:receiveOther", {
  chatId: GROUP, group: true, groupName: "Synthetic group", from: MEMBER, fromName: "Datta", fromOwner: false,
  mentionsLinked: false, repliesToLinked: false, text,
  message: { id, fromMe: false, remoteJid: GROUP, participant: MEMBER }, ...extra,
});
const check = async (name, run) => {
  try { await run(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error?.stack ?? error) }); }
  save();
};

try {
  const now = Date.now();
  await insert("installation", { defaultEngine: "codex", defaultAccess: "supervised", onboarding: "skipped", claimedAt: now, whatsappOwner: OWNER, ownerChannel: "telegram", ownerExternalId: "42", createdAt: now });
  await insert("whatsappLink", { mode: "separate", wanted: true, status: "connected", updatedAt: now });
  await insert("runners", { name: "Synthetic runner", token, createdAt: now, lastSeenAt: now, engines: [{ kind: "codex", installed: true, signedIn: true, auth: {}, models: [], updatedAt: now }] });
  const group = await insert("contacts", { channel: "whatsapp", externalId: GROUP, kind: "group", name: "Synthetic group", status: "allowed", createdAt: now, updatedAt: now });
  await insert("contacts", { channel: "whatsapp", externalId: PERSON, kind: "person", name: "Sam", handle: "+300", status: "allowed", createdAt: now, updatedAt: now });
  await insert("contacts", { channel: "telegram", externalId: TG_GROUP, kind: "group", name: "Synthetic Telegram group", status: "allowed", createdAt: now, updatedAt: now });

  await check("guest chats are given react_to_message", async () => {
    assert.ok(GUEST_TOOLS.includes("react_to_message"));
  });

  let tagged;
  await check("WhatsApp group: a message tagging Perry is reacted to, with its sender in the key", async () => {
    await groupMessage("WA-TAG-1", "@Perry when is the meetup?", { mentionsLinked: true });
    tagged = await claimLatest("whatsapp", GROUP);
    assert.deepEqual(tagged.guestMessage, { id: "WA-TAG-1", fromMe: false, remoteJid: GROUP, participant: MEMBER });
    assert.match(tagged.recalled, /You may react to the message that started this turn/);
    assert.match(tagged.instructions, /react only to a message that tagged you/);
    assert.deepEqual(await react(tagged._id, "👀"), { status: "queued", messageId: "WA-TAG-1" });
    assert.deepEqual(await react(tagged._id, "👍", "WA-TAG-1"), { status: "queued", messageId: "WA-TAG-1" });
    const rows = await reactionsTo(GROUP);
    assert.equal(rows.length, 1, "an update replaces the pending reaction");
    assert.deepEqual(rows[0].reaction, { id: "WA-TAG-1", fromMe: false, remoteJid: GROUP, participant: MEMBER, emoji: "👍" });
    assert.ok((await get(tagged._id)).reactionAt, "a reaction can be the whole reply");
  });

  await check("WhatsApp group: only the message that started the turn, never a later tag, another chat or the owner's", async () => {
    await groupMessage("WA-TAG-2", "@Perry and also bring snacks", { mentionsLinked: true });
    const steers = (await all("codexSteers")).filter(row => row.turnId === tagged._id);
    assert.equal(steers.length, 1, "the second tag joins the running turn");
    assert.equal(steers[0].guestMessage, undefined);
    for (const other of ["WA-TAG-2", "OWNER-1", "somebody-else"]) {
      const answer = await react(tagged._id, "👍", other);
      assert.equal(answer.status, "failed", other);
    }
    assert.ok((await reactionsTo(GROUP)).every(row => row.reaction.id === "WA-TAG-1"));
    assert.equal((await reactionsTo(OWNER)).length, 0);
    assert.equal(await call("whatsapp:react", { turnId: tagged._id, to: OWNER, reaction: { id: "WA-TAG-1", fromMe: false, emoji: "👍" } }), false);
    assert.equal(await call("whatsapp:react", { turnId: tagged._id, to: PERSON, reaction: { id: "WA-TAG-1", fromMe: false, emoji: "👍" } }), false);
    await finish(tagged._id);
  });

  await check("WhatsApp group: naming Perry or replying to it without a tag gets an answer but no reaction", async () => {
    for (const [id, text, extra] of [["WA-NAME", "Perry, what's the plan?", {}], ["WA-REPLY", "sounds good, what time?", { repliesToLinked: true }]]) {
      const before = (await reactionsTo(GROUP)).length;
      await groupMessage(id, text, extra);
      const turn = await claimLatest("whatsapp", GROUP);
      assert.equal(turn.guestMessage, undefined, id);
      assert.match(turn.recalled, /No reaction for this message/);
      const answer = await react(turn._id, "👀");
      assert.equal(answer.status, "failed", id);
      assert.match(answer.error, /tagged you/);
      assert.equal(await react(turn._id, "👀", id).then(result => result.status), "failed");
      assert.equal((await reactionsTo(GROUP)).length, before);
      await finish(turn._id);
    }
  });

  await check("WhatsApp group: a message not for Perry starts nothing and gets no reaction", async () => {
    const chat = await chatOf("whatsapp", GROUP);
    const turns = (await turnsOf(chat._id)).length;
    const reactions = (await reactionsTo(GROUP)).length;
    await groupMessage("WA-CHATTER", "anyone up for lunch?");
    assert.equal((await turnsOf(chat._id)).length, turns);
    assert.equal((await reactionsTo(GROUP)).length, reactions);
    assert.ok((await get(group)).recent.some(line => line.text === "anyone up for lunch?"), "kept only as context");
  });

  await check("WhatsApp contact: a person's own message is reacted to", async () => {
    await call("whatsapp:receive", { chatId: PERSON, text: "Can you remind me what Mani likes?", name: "Sam", messageId: "WA-DM-1", fromMe: false, remoteJid: PERSON });
    const turn = await claimLatest("whatsapp", PERSON);
    assert.deepEqual(turn.guestMessage, { id: "WA-DM-1", fromMe: false, remoteJid: PERSON });
    assert.match(turn.instructions, /acknowledge their message with react_to_message/);
    assert.deepEqual(await react(turn._id, "👀"), { status: "queued", messageId: "WA-DM-1" });
    assert.deepEqual((await reactionsTo(PERSON))[0].reaction, { id: "WA-DM-1", fromMe: false, remoteJid: PERSON, emoji: "👀" });
    assert.equal((await react(turn._id, "🙂", "WA-TAG-1")).status, "failed", "never another chat's message");
    await finish(turn._id);
  });

  await check("a chat no longer allowed, or Perry paused, gets no reaction, and a block drops one still queued", async () => {
    await call("whatsapp:receive", { chatId: PERSON, text: "One more thing", name: "Sam", messageId: "WA-DM-2", fromMe: false, remoteJid: PERSON });
    const turn = await claimLatest("whatsapp", PERSON);
    const contact = (await all("contacts")).find(row => row.externalId === PERSON);
    assert.equal((await reactionsTo(PERSON)).filter(row => row.state === "pending").length, 1, "the earlier reaction waits for WhatsApp");
    await runtime.call("contacts:setForDashboard", { key: process.env.DASHBOARD_KEY, id: contact._id, status: "blocked" });
    assert.equal((await reactionsTo(PERSON)).length, 0, "blocking drops what was still waiting to go to them");
    assert.equal((await react(turn._id, "👀")).status, "failed");
    assert.equal((await reactionsTo(PERSON)).length, 0);
    await patch(contact._id, { status: "allowed" });
    const installation = (await all("installation"))[0];
    await patch(installation._id, { paused: { at: Date.now(), by: "web" } });
    assert.equal((await react(turn._id, "👀")).status, "failed");
    await patch(installation._id, { paused: undefined });
    assert.equal((await reactionsTo(PERSON)).length, 0);
    await finish(turn._id);
  });

  await check("Telegram group: a message tagging the bot is reacted to; a reply without a tag is not", async () => {
    await call("ingest:receiveOther", { chatId: TG_GROUP, senderId: "555", text: "@perry_bot what's on today?", title: "Synthetic Telegram group", name: "Ana", chatType: "supergroup", username: "ana", mentions: ["perry_bot"], hasMedia: false, messageId: 77 });
    const turn = await claimLatest("telegram", TG_GROUP);
    assert.deepEqual(turn.guestMessage, { id: "77" });
    assert.deepEqual(await react(turn._id, "👀"), { status: "sent", messageId: "77" });
    assert.deepEqual(telegramReactions().at(-1).body, { chat_id: TG_GROUP, message_id: 77, reaction: [{ type: "emoji", emoji: "👀" }] });
    await finish(turn._id);
    const sent = telegramReactions().length;
    await call("ingest:receiveOther", { chatId: TG_GROUP, senderId: "555", text: "and tomorrow?", title: "Synthetic Telegram group", name: "Ana", chatType: "supergroup", username: "ana", replyToId: "999", hasMedia: false, messageId: 78 });
    const reply = await claimLatest("telegram", TG_GROUP);
    assert.equal(reply.guestMessage, undefined);
    assert.equal((await react(reply._id, "👀")).status, "failed");
    assert.equal((await react(reply._id, "👀", "78")).status, "failed");
    assert.equal(telegramReactions().length, sent);
    await finish(reply._id);
  });

  await check("reactions in group and contact chats start no turn, and a reaction-event turn cannot react", async () => {
    const turns = (await all("codexTurns")).length;
    const scheduled = scheduledTurns().length;
    const sent = telegramReactions().length;
    const outbox = (await all("whatsappOutbox")).filter(row => row.kind === "reaction").length;
    for (const externalId of [GROUP, PERSON]) {
      await call("reactions:receive", { channel: "whatsapp", externalId, messageId: "WA-TAG-1", emojis: ["❤️"], at: Date.now(), fromMe: true, remoteJid: externalId });
    }
    for (const user of [555, 42]) {
      await call("ingest:handleTelegram", { update: { message_reaction: { chat: { id: Number(TG_GROUP) }, message_id: 77, user: { id: user }, date: Math.floor(Date.now() / 1000), new_reaction: [{ type: "emoji", emoji: "🔥" }] } } });
    }
    assert.equal((await all("codexTurns")).length, turns);
    assert.equal(scheduledTurns().length, scheduled);
    await groupMessage("WA-TAG-3", "@Perry thanks!", { mentionsLinked: true });
    const turn = await claimLatest("whatsapp", GROUP);
    await patch(turn._id, { reactionEvent: true });
    assert.equal((await react(turn._id, "❤️")).status, "failed");
    await finish(turn._id);
    assert.equal(telegramReactions().length, sent);
    assert.equal((await all("whatsappOutbox")).filter(row => row.kind === "reaction").length, outbox);
  });

  await check("the owner's own WhatsApp chat still reacts to the owner's message", async () => {
    await call("whatsapp:receive", { chatId: OWNER, text: "check my calendar", messageId: "OWNER-1", fromMe: false, remoteJid: OWNER });
    const args = scheduledTurns().find(item => item.externalId === OWNER);
    assert.ok(args, "the owner's message schedules a turn");
    await call("brain:handleTurn", args);
    const turn = await claimLatest("whatsapp", OWNER);
    assert.equal(turn.guestMessage, undefined);
    assert.equal((await react(turn._id, "👀")).status, "queued");
    assert.equal((await reactionsTo(OWNER))[0].reaction.id, "OWNER-1");
    await finish(turn._id);
  });

  report.passed = report.cases.length > 0 && report.cases.every(item => item.passed);
  save();
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
} finally {
  await runtime.stop(); sql.close(); globalThis.fetch = originalFetch;
  const absolute = resolve(scratch);
  if (absolute.startsWith(resolve(tmpdir()) + sep) && absolute.includes("perry-guest-reactions-")) rmSync(absolute, { recursive: true, force: true });
}
