// Native runner question -> SQLite -> channel delivery -> owner reply -> same runner.
// Failure inventory was written first in failure-cases.md. No paid model or real phone.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

if (!process.argv[2]) throw Error("Pass a disposable result directory");
const out = resolve(process.argv[2]);
mkdirSync(out, { recursive: true });
const scratchRoot = resolve(process.env.PERRY_E2E_DIR ?? tmpdir());
mkdirSync(scratchRoot, { recursive: true });
const home = mkdtempSync(join(scratchRoot, "perry-phone-questions-"));
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = "synthetic-phone-questions-key";
process.env.PERRY_CREDENTIAL_KEY = "79".repeat(32);
process.env.TELEGRAM_API_BASE = "http://phone-questions.invalid";
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.COMPOSIO_API_KEY;
const TOKEN = "synthetic-phone-questions-runner";
const KEY = process.env.DASHBOARD_KEY;
const OWNER = "15550001111@s.whatsapp.net";
const OTHER = "15550002222@s.whatsapp.net";
const TELEGRAM = "555000111";
const nativeFetch = globalThis.fetch;
const sentTelegram = [];
let telegramRefusal = false;
let telegramAfterSend;
let telegramRateLimit;
let telegramSequence = 8000;
globalThis.fetch = async (input, options) => {
  const url = String(input instanceof Request ? input.url : input);
  if (!url.startsWith("http://phone-questions.invalid/bot")) throw Error("External network disabled in phone question replay");
  if (!url.endsWith("/sendMessage")) throw Error(`Unexpected Telegram method: ${url.split("/").at(-1)}`);
  if (telegramRefusal) throw Error("Synthetic uncertain Telegram transport");
  if (telegramRateLimit) {
    const effect = telegramRateLimit;
    telegramRateLimit = undefined;
    await effect();
    return Response.json({ ok: false, error_code: 429, description: "Synthetic rate limit", parameters: { retry_after: 0 } });
  }
  const body = JSON.parse(options.body);
  const id = ++telegramSequence;
  sentTelegram.push({ ...body, id });
  await telegramAfterSend?.();
  return Response.json({ ok: true, result: { message_id: id } });
};
const report = { ranAt: new Date().toISOString(), passed: false, cases: [], realMessagesSent: 0, modelTurnsStarted: 0, homeRemoved: false };
const baselineFiles = [];
const save = () => writeFileSync(join(out, "result.json"), JSON.stringify(report, null, 2) + "\n");
save();
let rt, sql, restore = () => {};
const check = async (name, work) => {
  try { await work(); report.cases.push({ name, passed: true }); }
  catch (error) { report.cases.push({ name, passed: false, error: String(error) }); }
  finally { restore(); }
  console.log(JSON.stringify(report.cases.at(-1)));
  save();
};
try {
  const [{ Runtime }, { default: schema }, { modules: currentModules }] = await Promise.all([
    import("../../server/runtime.ts"), import("../../convex/schema.ts"), import("../../server/modules.ts"),
  ]);
  const modules = { ...currentModules };
  if (process.argv.includes("--baseline")) {
    report.baselineCommit = "c505a6d9f61177ab5449ef42e72c91d84094120a";
    for (const name of ["questions", "whatsapp", "ingest"]) {
      const path = resolve(`convex/.phone-question-baseline-${name}.ts`);
      baselineFiles.push(path);
      writeFileSync(path, execFileSync("git", ["show", `${report.baselineCommit}:convex/${name}.ts`], { encoding: "utf8" }));
      modules[name] = await import(pathToFileURL(path).href);
    }
  }
  const open = async () => {
    sql = new DatabaseSync(join(home, "perry.sqlite"));
    rt = new Runtime(sql, schema, modules, { storageDir: join(home, "storage") });
    await rt.stop();
  };
  await open();
  const mutate = (name, args = {}) => rt.runMutation(name, args, { internal: true });
  const query = async (name, args = {}) => (await rt.runQuery(name, args, { internal: true })).value;
  const runnerId = await mutate("runner:createToken", { token: TOKEN, name: "Synthetic question computer" });
  const installation = rt.store.insert("installation", { timezone: "UTC", claimedAt: Date.now(), whatsappOwner: OWNER, ownerChannel: "telegram", ownerExternalId: TELEGRAM });
  const link = rt.store.insert("whatsappLink", { mode: "separate", wanted: true, status: "connected", me: "15550003333@s.whatsapp.net" });
  await mutate("secrets:set", { name: "TELEGRAM_BOT_TOKEN", value: "555000333:synthetic-question-token" });
  restore = () => {
    rt.store.patch(installation, { paused: undefined, whatsappOwner: OWNER, ownerChannel: "telegram", ownerExternalId: TELEGRAM });
    rt.store.patch(link, { wanted: true });
    telegramRefusal = false;
    telegramAfterSend = undefined;
    telegramRateLimit = undefined;
  };
  const chat = async (channel, externalId) => {
    const threadId = await mutate("agentStore:createThread", { userId: `synthetic-question-${channel}` });
    return rt.store.insert("conversations", { channel, externalId, threadId, access: "full", lastMessageAt: Date.now() });
  };
  const waChat = await chat("whatsapp", OWNER);
  const tgChat = await chat("telegram", TELEGRAM);
  const webChat = await chat("web", "dashboard");
  let sequence = 0;
  const options = [{ label: "Brief", description: "A short answer" }, { label: "Detailed", description: "Include the reasoning" }];
  const choice = (id = "format", extra = {}) => ({ id, header: "Reply format", question: "How much detail would you like?", options, ...extra });
  const free = (id = "topic") => ({ id, header: "Topic", question: "What topic should I cover?", options: [] });
  const newTurn = (conversationId = waChat, extra = {}) => {
    const runId = rt.store.insert("runs", { conversationId, prompt: "Synthetic question replay", status: "running", startedAt: Date.now() });
    return rt.store.insert("codexTurns", { runnerId, conversationId, runId, prompt: "Synthetic question replay", instructions: "Fixture only", status: "running", createdAt: Date.now(), startedAt: Date.now(), ...extra });
  };
  const request = async (questions = [choice()], conversationId = waChat, extra = {}) => {
    const turn = newTurn(conversationId, extra);
    const nativeId = `synthetic-native-question-${++sequence}`;
    const id = await mutate("questions:request", { token: TOKEN, turnId: turn, nativeId, questions });
    return { id, turn, nativeId, questions };
  };
  const rows = id => rt.store.all("whatsappOutbox").filter(row => row.question?.id === id);
  const response = id => query("questions:response", { token: TOKEN, id });
  const code = id => {
    const value = rt.store.get(id)?.phone?.code;
    assert.match(value ?? "", /^[a-f0-9]{12}$/);
    return value;
  };
  const sendWa = async (id, index) => {
    const outgoing = rows(id).filter(row => index === undefined || row.question.index === index);
    assert.ok(outgoing.length > 0, "The question must reach the WhatsApp outbox");
    for (const row of outgoing) {
      const reservation = await mutate("whatsapp:reserveMessageId", { id: row._id });
      assert.ok(reservation, "An active question must be reservable");
      await mutate("whatsapp:sent", { id: row._id });
    }
    return outgoing;
  };
  const wa = (text, replyTo, extra = {}) => mutate("whatsapp:acceptOwner", { chatId: OWNER, text, stored: [], messageId: `synthetic-inbound-${++sequence}`, ...(replyTo ? { replyTo } : {}), ...extra });
  const command = (id, value, index = 0) => `/answer ${code(id)}.${index + 1} ${value}`;
  const tg = (text, replyMessageId, extra = {}) => mutate("ingest:acceptTelegram", { botId: "555000333", update: { update_id: ++sequence, message: { message_id: sequence, date: Math.floor(Date.now() / 1000), text, chat: { id: Number(TELEGRAM), type: "private" }, from: { id: Number(TELEGRAM), is_bot: false, first_name: "Synthetic owner" }, ...(replyMessageId ? { reply_to_message: { message_id: replyMessageId, from: { id: 555000333 } } } : {}), ...extra } } });

  await check("native runner question queues owner WhatsApp prompts without starting another turn", async () => {
    const before = rt.store.all("codexTurns").length;
    const item = await request();
    assert.equal(rows(item.id).length, 1);
    assert.equal(rows(item.id)[0].to, OWNER);
    assert.match(rows(item.id)[0].text, /How much detail/);
    assert.match(rows(item.id)[0].text, /Brief/);
    assert.match(rows(item.id)[0].text, new RegExp(code(item.id)));
    assert.equal(rt.store.all("codexTurns").length, before + 1);
    assert.deepEqual(await response(item.id), {});
  });
  if (process.argv.includes("--baseline")) {
    await check("ordinary inbound text still remains ordinary while a question waits", async () => {
      const item = await request();
      await wa("Please also check my calendar");
      assert.equal(rt.store.get(item.id).status, "pending");
      assert.deepEqual(await response(item.id), {});
    });
  } else {
    await check("inherited-property question IDs queue prompts and remain unanswered until their own reply", async () => {
      for (const name of ["constructor", "toString", "__proto__"]) {
        const item = await request([choice(), free(name)]);
        assert.equal(rows(item.id).length, 2);
        await wa(command(item.id, "1"));
        assert.equal(rt.store.get(item.id).status, "pending");
        assert.deepEqual(await response(item.id), {});
        await wa(command(item.id, `Answer for ${name}`, 1));
        assert.deepEqual(await response(item.id), { answers: { format: ["Brief"], [name]: [`Answer for ${name}`] } });
      }
    });
    await check("dashboard validation requires an own answer for inherited-property question IDs", async () => {
      for (const name of ["constructor", "toString", "__proto__"]) {
        const item = await request([choice(), free(name)]);
        await assert.rejects(mutate("questions:answer", { key: KEY, id: item.id, answers: { format: ["Brief"] } }), /Answer every question/);
        assert.equal(rt.store.get(item.id).status, "pending");
        await mutate("questions:answer", { key: KEY, id: item.id, answers: { format: ["Brief"], [name]: ["Dashboard answer"] } });
        assert.deepEqual(await response(item.id), { answers: { format: ["Brief"], [name]: ["Dashboard answer"] } });
      }
    });
    await check("native request replay keeps the same batch and exactly one prompt per question", async () => {
      const item = await request([choice(), free()]);
      assert.equal(await mutate("questions:request", { token: TOKEN, turnId: item.turn, nativeId: item.nativeId, questions: item.questions }), item.id);
      assert.equal(rows(item.id).length, 2);
    });
    await check("quoted WhatsApp option reply resumes the same runner with the option label", async () => {
      const item = await request();
      const [sent] = await sendWa(item.id);
      const turns = rt.store.all("codexTurns").length;
      await wa("2", sent.messageId);
      assert.deepEqual(await response(item.id), { answers: { format: ["Detailed"] } });
      assert.equal(rt.store.all("codexTurns").length, turns);
    });
    await check("explicit answer code accepts free text without a quoted message", async () => {
      const item = await request([free()]);
      await wa(command(item.id, "Travel planning\nfor next week"));
      assert.deepEqual(await response(item.id), { answers: { topic: ["Travel planning\nfor next week"] } });
    });
    await check("partial batch answers stay pending and are hidden from the waiting runner", async () => {
      const item = await request([choice(), free()]);
      await wa(command(item.id, "1"));
      assert.equal(rt.store.get(item.id).status, "pending");
      assert.deepEqual(rt.store.get(item.id).answers, { format: ["Brief"] });
      assert.deepEqual(await response(item.id), {});
      await wa(command(item.id, "Hiking routes", 1));
      assert.deepEqual(await response(item.id), { answers: { format: ["Brief"], topic: ["Hiking routes"] } });
    });
    await check("partial answers and quote correlation survive a native database restart", async () => {
      const item = await request([choice(), free()]);
      await wa(command(item.id, "2"));
      const sent = await sendWa(item.id, 1);
      await rt.stop(); sql.close(); await open();
      assert.deepEqual(await response(item.id), {});
      await wa("Local history", sent[0].messageId);
      assert.deepEqual(await response(item.id), { answers: { format: ["Detailed"], topic: ["Local history"] } });
    });
    await check("multiple-selection numbers map to distinct option labels", async () => {
      const item = await request([choice("format", { multiple: true })]);
      await wa(command(item.id, "2, 1"));
      assert.deepEqual(await response(item.id), { answers: { format: ["Detailed", "Brief"] } });
    });
    await check("commas in a free-text answer remain one value on a multiple-choice question", async () => {
      const item = await request([choice("format", { multiple: true })]);
      await wa(command(item.id, "San Francisco, CA"));
      assert.deepEqual(await response(item.id), { answers: { format: ["San Francisco, CA"] } });
    });
    await check("invalid or multiple choices for single-select never complete the request", async () => {
      const item = await request();
      for (const value of ["9", "0", "1, 2"]) {
        await wa(command(item.id, value));
        assert.equal(rt.store.get(item.id).status, "pending");
      }
      await wa(command(item.id, "2"));
      assert.deepEqual(await response(item.id), { answers: { format: ["Detailed"] } });
    });
    await check("literal numeric text and numeric answers without options stay text", async () => {
      const item = await request();
      await wa(command(item.id, "text: 2026"));
      assert.deepEqual(await response(item.id), { answers: { format: ["2026"] } });
      const noOptions = await request([free()]);
      await wa(command(noOptions.id, "2026"));
      assert.deepEqual(await response(noOptions.id), { answers: { topic: ["2026"] } });
    });
    await check("bare option numbers and ordinary text do not answer any pending question", async () => {
      const item = await request();
      await wa("2"); await wa("Please check the weather too");
      assert.equal(rt.store.get(item.id).status, "pending");
      assert.deepEqual(await response(item.id), {});
    });
    await check("a late quoted answer cannot overwrite a dashboard answer or become a new prompt", async () => {
      const item = await request();
      const [sent] = await sendWa(item.id);
      await mutate("questions:answer", { key: KEY, id: item.id, answers: { format: ["Brief"] } });
      const inbox = rt.store.all("phoneInbox").length;
      await wa("2", sent.messageId);
      assert.deepEqual(await response(item.id), { answers: { format: ["Brief"] } });
      assert.equal(rt.store.all("phoneInbox").length, inbox);
    });
    await check("stale command is consumed with no question mutation or queued input", async () => {
      const item = await request();
      const text = command(item.id, "2");
      rt.store.patch(item.turn, { stopRequested: true });
      const inbox = rt.store.all("phoneInbox").length;
      await wa(text);
      assert.equal(rt.store.get(item.id).status, "pending");
      assert.deepEqual(await response(item.id), { cancelled: true });
      assert.equal(rt.store.all("phoneInbox").length, inbox);
    });
    await check("quoted stop command reaches the native command path without answering the question", async () => {
      const item = await request();
      const [sent] = await sendWa(item.id);
      const before = sql.prepare("SELECT count(*) AS count FROM _scheduled WHERE name='brain:handleTurn' AND json_extract(args,'$.text')='/stop'").get().count;
      await wa("/stop", sent.messageId);
      assert.equal(rt.store.get(item.id).status, "pending");
      assert.equal(rt.store.get(item.id).answers, undefined);
      assert.equal(sql.prepare("SELECT count(*) AS count FROM _scheduled WHERE name='brain:handleTurn' AND json_extract(args,'$.text')='/stop'").get().count, before + 1);
    });
    await check("malformed answer commands give syntax guidance without queueing new input", async () => {
      const item = await request();
      const inbox = rt.store.all("phoneInbox").length;
      const before = rt.store.all("whatsappOutbox").length;
      for (const text of ["/answer", "/answer not-a-code 2", `/answer ${code(item.id)}.1`]) await wa(text);
      assert.equal(rt.store.get(item.id).status, "pending");
      assert.equal(rt.store.all("phoneInbox").length, inbox);
      assert.equal(rt.store.all("whatsappOutbox").length, before + 3);
      assert.ok(rt.store.all("whatsappOutbox").slice(-3).every(row => /question code/.test(row.text)));
    });
    await check("a paused question cannot be answered by phone or dashboard and cannot resume the runner", async () => {
      const item = await request();
      const text = command(item.id, "2");
      rt.store.patch(installation, { paused: { at: Date.now(), by: "web" } });
      await wa(text);
      assert.equal(rt.store.get(item.id).status, "pending");
      assert.deepEqual(await response(item.id), { cancelled: true });
      await assert.rejects(mutate("questions:answer", { key: KEY, id: item.id, answers: { format: ["Brief"] } }));
    });
    await check("WhatsApp durable receipt replay answers once and creates one acknowledgement", async () => {
      const item = await request();
      const messageId = `synthetic-replayed-${++sequence}`;
      const receiptId = rt.store.insert("whatsappInbox", { key: `synthetic-${sequence}`, account: "synthetic-account", remote: OWNER, messageId, mode: "separate", state: "pending", createdAt: Date.now(), nextAt: Date.now(), attempts: 0 });
      const args = { chatId: OWNER, text: command(item.id, "2"), stored: [], messageId, receiptId };
      const before = rt.store.all("whatsappOutbox").length;
      await mutate("whatsapp:acceptOwner", args);
      const after = rt.store.all("whatsappOutbox").length;
      assert.equal(after, before + 1);
      await mutate("whatsapp:acceptOwner", args);
      assert.equal(rt.store.all("whatsappOutbox").length, after);
      assert.deepEqual(await response(item.id), { answers: { format: ["Detailed"] } });
    });
    await check("untrusted reference text is not interpreted as a question answer", async () => {
      const item = await request();
      await wa(command(item.id, "2"), undefined, { controls: false, context: "Synthetic quoted outside data" });
      assert.equal(rt.store.get(item.id).status, "pending");
    });
    await check("stopped, paused and changed-owner questions are revoked before WhatsApp sending", async () => {
      for (const scenario of ["stop", "pause", "owner", "unpair"]) {
        const item = await request();
        const row = rows(item.id)[0];
        assert.ok(row);
        if (scenario === "stop") rt.store.patch(item.turn, { stopRequested: true });
        if (scenario === "pause") rt.store.patch(installation, { paused: { at: Date.now(), by: "web" } });
        if (scenario === "owner") rt.store.patch(installation, { whatsappOwner: OTHER });
        if (scenario === "unpair") rt.store.patch(link, { wanted: false });
        assert.equal(await mutate("whatsapp:reserveMessageId", { id: row._id }), null);
        restore();
      }
    });
    await check("answering on the dashboard revokes the queued WhatsApp question", async () => {
      const item = await request();
      const row = rows(item.id)[0];
      await mutate("questions:answer", { key: KEY, id: item.id, answers: { format: ["Brief"] } });
      assert.equal(await mutate("whatsapp:reserveMessageId", { id: row._id }), null);
    });
    await check("quoted replies wait for the complete multipart question delivery", async () => {
      const item = await request([choice("format", { question: "Long question context. ".repeat(500) })]);
      const outgoing = rows(item.id);
      assert.ok(outgoing.length > 1);
      await mutate("whatsapp:reserveMessageId", { id: outgoing[0]._id });
      await mutate("whatsapp:sent", { id: outgoing[0]._id });
      await wa("2", outgoing[0].messageId);
      assert.equal(rt.store.get(item.id).status, "pending");
      for (const row of outgoing.slice(1)) { await mutate("whatsapp:reserveMessageId", { id: row._id }); await mutate("whatsapp:sent", { id: row._id }); }
      await wa("2", outgoing[0].messageId);
      assert.equal(rt.store.get(item.id).status, "answered");
    });
    await check("question prompts redact credentials already saved before queueing", async () => {
      const secret = "synthetic-question-secret-7415";
      await mutate("vault:save", { label: "Synthetic question credential", value: secret, by: "owner" });
      const item = await request([free("secret-context")].map(q => ({ ...q, question: `Which account holds ${secret}?` })));
      const [row] = rows(item.id);
      const reservation = await mutate("whatsapp:reserveMessageId", { id: row._id });
      const text = typeof reservation === "string" ? rt.store.get(row._id).text : reservation?.text;
      assert.ok(text);
      assert.ok(!text.includes(secret));
    });
    await check("a credential saved after queueing revokes the captured WhatsApp prompt", async () => {
      const secret = "synthetic-late-question-secret-8351";
      const item = await request([{ ...free(), question: `Which account holds ${secret}?` }]);
      const [row] = rows(item.id);
      assert.ok(row.text.includes(secret));
      await mutate("vault:save", { label: "Late synthetic question credential", value: secret, by: "owner" });
      assert.equal(await mutate("whatsapp:reserveMessageId", { id: row._id }), null);
      assert.equal(rt.store.get(row._id).state, "failed");
    });
    await check("late credential redaction revokes both WhatsApp chunks even when the credential crosses their boundary", async () => {
      const secret = "synthetic-cross-chunk-secret-6193";
      const prefixLength = "Perry needs your answer\n\n".length;
      const item = await request([{ ...free(), header: "", question: "A".repeat(4000 - prefixLength - 8) + secret + "B".repeat(200) }]);
      const outgoing = rows(item.id);
      assert.ok(outgoing.length > 1);
      assert.ok(outgoing[0].text.includes(secret.slice(0, 8)));
      assert.ok(!outgoing[0].text.includes(secret));
      assert.ok(outgoing[1].text.includes(secret.slice(8)));
      await mutate("vault:save", { label: "Cross-chunk synthetic credential", value: secret, by: "owner" });
      for (const row of outgoing) assert.equal(await mutate("whatsapp:reserveMessageId", { id: row._id }), null);
    });
    await check("a quoted question remains answerable after native one-day WhatsApp outbox collection", async () => {
      const item = await request();
      const [sent] = await sendWa(item.id);
      const nativeNow = Date.now;
      const future = nativeNow() + 86_400_100;
      try {
        Date.now = () => future;
        await mutate("whatsapp:send", { to: OWNER, text: "Synthetic later message to trigger native outbox collection" });
        const fresh = rt.store.all("whatsappOutbox").find(row => row.text === "Synthetic later message to trigger native outbox collection");
        await mutate("whatsapp:reserveMessageId", { id: fresh._id });
        await mutate("whatsapp:sent", { id: fresh._id });
        assert.equal(rt.store.get(sent._id), null);
        await wa("2", sent.messageId);
        assert.deepEqual(await response(item.id), { answers: { format: ["Detailed"] } });
      } finally { Date.now = nativeNow; }
    });
    await check("web chat questions stay in the dashboard", async () => {
      const item = await request([choice()], webChat);
      assert.equal(rows(item.id).length, 0);
      assert.equal(rt.store.get(item.id).phone, undefined);
    });
    await check("guest, preparation and maintenance turns cannot request owner input", async () => {
      for (const extra of [{ guest: true }, { preparation: true }, { flush: true }, { checkpoint: true }, { kind: "compact" }]) {
        const turn = newTurn(waChat, extra);
        await assert.rejects(mutate("questions:request", { token: TOKEN, turnId: turn, nativeId: `forbidden-${++sequence}`, questions: [choice()] }));
      }
    });
    await check("an unrelated runner cannot read the question response", async () => {
      const otherToken = "synthetic-question-other-runner";
      await mutate("runner:createToken", { token: otherToken, name: "Other synthetic computer" });
      const item = await request();
      assert.deepEqual(await query("questions:response", { token: otherToken, id: item.id }), { cancelled: true });
    });
    await check("Telegram prompt delivery stores quote IDs and quoted reply completes the native question", async () => {
      const item = await request([choice()], tgChat);
      const before = sentTelegram.length;
      await rt.runAction("questions:promptOnTelegram", { id: item.id, index: 0 }, { internal: true });
      const delivered = sentTelegram.slice(before);
      assert.ok(delivered.length > 0);
      assert.equal(String(delivered[0].chat_id), TELEGRAM);
      await tg("2", delivered[0].id);
      assert.deepEqual(await response(item.id), { answers: { format: ["Detailed"] } });
    });
    await check("Telegram explicit code works and update replay cannot overwrite the answer", async () => {
      const item = await request([free()], tgChat);
      await tg(command(item.id, "Calendar planning"));
      await tg(command(item.id, "Changed answer"));
      assert.deepEqual(await response(item.id), { answers: { topic: ["Calendar planning"] } });
    });
    await check("Telegram durable update replay creates one acknowledgement and preserves the answer", async () => {
      const item = await request([choice()], tgChat);
      const updateId = ++sequence;
      const update = { update_id: updateId, message: { message_id: updateId, date: Math.floor(Date.now() / 1000), text: command(item.id, "2"), chat: { id: Number(TELEGRAM), type: "private" }, from: { id: Number(TELEGRAM), is_bot: false } } };
      await mutate("ingest:acceptTelegram", { botId: "555000333", update });
      const callbacks = sql.prepare("SELECT count(*) AS count FROM _scheduled").get().count;
      await mutate("ingest:acceptTelegram", { botId: "555000333", update });
      assert.equal(sql.prepare("SELECT count(*) AS count FROM _scheduled").get().count, callbacks);
      assert.deepEqual(await response(item.id), { answers: { format: ["Detailed"] } });
    });
    await check("forwarded Telegram answer commands remain outside data instead of owner answers", async () => {
      const item = await request([choice()], tgChat);
      const text = command(item.id, "2");
      await tg(text, undefined, { forward_origin: { type: "hidden_user", sender_user_name: "Synthetic outside sender", date: Math.floor(Date.now() / 1000) } });
      assert.equal(rt.store.get(item.id).status, "pending");
      const pending = rt.store.all("phoneInbox").find(row => row.conversationId === tgChat);
      assert.ok(pending.parts.includes(text));
      assert.equal(pending.outside, true);
    });
    await check("Telegram prompt claim prevents duplicate sends", async () => {
      const item = await request([choice()], tgChat);
      const before = sentTelegram.length;
      await rt.runAction("questions:promptOnTelegram", { id: item.id, index: 0 }, { internal: true });
      const delivered = sentTelegram.length;
      assert.ok(delivered > before);
      await rt.runAction("questions:promptOnTelegram", { id: item.id, index: 0 }, { internal: true });
      assert.equal(sentTelegram.length, delivered);
    });
    await check("uncertain Telegram sends are retained without replay and code replies still work", async () => {
      const item = await request([choice()], tgChat);
      telegramRefusal = true;
      await rt.runAction("questions:promptOnTelegram", { id: item.id, index: 0 }, { internal: true }).catch(() => {});
      assert.equal(rt.store.get(item.id).phone.telegram[0].state, "uncertain");
      telegramRefusal = false;
      const before = sentTelegram.length;
      await rt.runAction("questions:promptOnTelegram", { id: item.id, index: 0 }, { internal: true });
      assert.equal(sentTelegram.length, before);
      await tg(command(item.id, "1"));
      assert.deepEqual(await response(item.id), { answers: { format: ["Brief"] } });
    });
    await check("Telegram rechecks liveness between multipart sends and retains partial delivery as uncertain", async () => {
      const item = await request([choice("format", { question: "Detailed source context. ".repeat(500) })], tgChat);
      const before = sentTelegram.length;
      telegramAfterSend = async () => { rt.store.patch(item.turn, { stopRequested: true }); };
      await rt.runAction("questions:promptOnTelegram", { id: item.id, index: 0 }, { internal: true });
      assert.equal(sentTelegram.length, before + 1);
      const attempt = rt.store.get(item.id).phone.telegram[0];
      assert.equal(attempt.state, "uncertain");
      assert.equal(attempt.messageIds.length, 1);
      assert.deepEqual(await response(item.id), { cancelled: true });
    });
    await check("a late vault credential stops remaining Telegram chunks before captured text can leak", async () => {
      const secret = "synthetic-telegram-between-chunk-secret-8756";
      const item = await request([{ ...free(), question: "Safe context. ".repeat(500) + secret }], tgChat);
      const before = sentTelegram.length;
      telegramAfterSend = async () => { await mutate("vault:save", { label: "Telegram late chunk credential", value: secret, by: "owner" }); };
      await rt.runAction("questions:promptOnTelegram", { id: item.id, index: 0 }, { internal: true });
      const delivered = sentTelegram.slice(before);
      assert.equal(delivered.length, 1);
      assert.ok(!delivered[0].text.includes(secret));
      assert.equal(rt.store.get(item.id).phone.telegram[0].state, "uncertain");
    });
    await check("a late vault credential stops a Telegram HTTP retry before stale prompt text is resent", async () => {
      const secret = "synthetic-telegram-retry-secret-9537";
      const item = await request([{ ...free(), question: `Which account holds ${secret}?` }], tgChat);
      const before = sentTelegram.length;
      telegramRateLimit = async () => { await mutate("vault:save", { label: "Telegram retry credential", value: secret, by: "owner" }); };
      await rt.runAction("questions:promptOnTelegram", { id: item.id, index: 0 }, { internal: true });
      assert.equal(sentTelegram.length, before);
      assert.equal(rt.store.get(item.id).phone.telegram[0].state, "uncertain");
    });
    await check("a changed Telegram owner prevents a scheduled question from sending", async () => {
      const item = await request([choice()], tgChat);
      rt.store.patch(installation, { ownerExternalId: "999000222" });
      const before = sentTelegram.length;
      await rt.runAction("questions:promptOnTelegram", { id: item.id, index: 0 }, { internal: true });
      assert.equal(sentTelegram.length, before);
    });
    await check("Telegram answers from another sender cannot mutate owner questions", async () => {
      const item = await request([choice()], tgChat);
      await tg(command(item.id, "2"), undefined, { from: { id: 999000222, is_bot: false }, chat: { id: 999000222, type: "private" } });
      assert.equal(rt.store.get(item.id).status, "pending");
    });
    await check("a WhatsApp answer code cannot answer a Telegram batch", async () => {
      const item = await request([choice()], tgChat);
      await wa(command(item.id, "2"));
      assert.equal(rt.store.get(item.id).status, "pending");
    });
  }
} finally {
  if (rt) await rt.stop();
  if (sql) sql.close();
  globalThis.fetch = nativeFetch;
  for (const path of baselineFiles) rmSync(path, { force: true });
  if (!resolve(home).startsWith(scratchRoot + sep)) throw Error("Fixture cleanup escaped its temporary root");
  rmSync(home, { recursive: true, force: true });
  report.homeRemoved = !existsSync(home);
  report.passed = report.cases.length > 0 && report.cases.every(item => item.passed);
  save();
}
if (!report.passed) process.exitCode = 1;
