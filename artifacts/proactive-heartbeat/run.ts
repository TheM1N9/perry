import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

// Failure cases and the model boundary are documented in README.md.
const out = resolve("artifacts/proactive-heartbeat");
const home = resolve("node_modules/.cache/perry-proactive-heartbeat", `run-${Date.now()}`);
mkdirSync(home, { recursive: true });
process.env.PERRY_HOME = home;
process.env.DASHBOARD_KEY = "proactive-heartbeat-fixture";
process.env.PERRY_CREDENTIAL_KEY = "88".repeat(32);
const realFetch = globalThis.fetch;
globalThis.fetch = async () => { throw new Error("Network disabled in heartbeat verification"); };

const checks: string[] = [];
const pass = (name: string) => { checks.push(name); console.log(`PASS ${name}`); };
let runtime: import("../../server/runtime").Runtime | undefined;
let sql: DatabaseSync | undefined;
let failure: string | undefined;
let prompt = "";
try {
  const [{ Runtime }, { default: schema }, { modules }] = await Promise.all([
    import("../../server/runtime"), import("../../convex/schema"), import("../../server/modules"),
  ]);
  sql = new DatabaseSync(join(home, "fixture.sqlite"));
  runtime = new Runtime(sql, schema as never, modules, { storageDir: join(home, "storage") });
  await runtime.stop();
  const rt = runtime;
  const db = rt.store;
  const mutate = (name: string, args: object = {}) => rt.runMutation(name, args, { internal: true });
  const run = (id: string) => rt.runAction("jobs:run", { id }, { internal: true });
  const heartbeat = () => {
    const row = db.all("jobs").find((job) => job.builtin === "heartbeat");
    assert(row);
    return row;
  };
  const scheduled = (name: string) => sql!.prepare("SELECT args FROM _scheduled WHERE name = ? ORDER BY createdAt").all(name)
    .map((row) => JSON.parse(String(row.args)) as Record<string, unknown>);
  const install = db.insert("installation", { timezone: "Asia/Kolkata", onboarding: "skipped", createdAt: Date.now() });
  await mutate("jobs:tick");
  const id = heartbeat()._id;
  assert.equal(heartbeat().schedule, "*/30 8-22 * * *");
  await mutate("jobs:tick");
  assert.equal(db.all("jobs").filter((job) => job.builtin === "heartbeat").length, 1);
  pass("fresh heartbeat uses half-hour schedule and is created once");

  db.patch(id, { schedule: "0 9,13,17,21 * * *", enabled: false, nextRunAt: 0, prompt: "old prompt" });
  await mutate("jobs:tick");
  assert.equal(heartbeat().schedule, "*/30 8-22 * * *");
  assert.equal(heartbeat().enabled, false);
  assert(Number(heartbeat().nextRunAt) > Date.now());
  assert(String(heartbeat().prompt).includes("Include sent mail and replies"));
  db.patch(id, { schedule: "5 11 * * 2", nextRunAt: 12345 });
  await mutate("jobs:tick");
  assert.equal(heartbeat().schedule, "5 11 * * 2");
  assert.equal(heartbeat().nextRunAt, 12345);
  assert.equal(heartbeat().enabled, false);
  pass("upgrade updates old defaults and preserves pause and custom scheduling");

  for (let index = 0; index < 12; index++) {
    db.insert("conversations", { channel: "web", externalId: `fixture:${index}`, threadId: `fixture-${index}`, title: `Owner chat ${index}`, lastMessageAt: Date.now() + index });
  }
  const project = db.insert("projects", { name: "Private project", createdAt: Date.now(), updatedAt: Date.now() });
  db.insert("conversations", { channel: "web", externalId: "fixture:project", threadId: "project-thread", title: "PRIVATE_PROJECT_TITLE", projectId: project, lastMessageAt: Date.now() });
  const contact = db.insert("contacts", { name: "Guest", createdAt: Date.now() });
  db.insert("conversations", { channel: "telegram", externalId: "guest", threadId: "guest-thread", title: "PRIVATE_GUEST_TITLE", contactId: contact, lastMessageAt: Date.now() });
  await mutate("memories:noteAlert", { text: "Previously noticed a calendar clash.", at: "09:00" });
  db.patch(id, { enabled: true, schedule: "*/30 8-22 * * *", nextRunAt: Date.now() - 1 });
  await mutate("jobs:tick");
  assert.equal(scheduled("jobs:run").length, 1);
  await run(id);
  const turns = scheduled("brain:handleTurn");
  assert.equal(turns.length, 1);
  assert.equal(turns[0].outside, true);
  prompt = String(turns[0].text);
  writeFileSync(join(out, "heartbeat-prompt.txt"), prompt + "\n");
  assert(prompt.includes("Asia/Kolkata"));
  assert(prompt.includes("UTC+05:30"));
  assert(prompt.includes("Previously noticed a calendar clash."));
  assert.equal((prompt.match(/Owner chat \d+/g) ?? []).length, 8);
  assert(!prompt.includes("PRIVATE_PROJECT_TITLE"));
  assert(!prompt.includes("PRIVATE_GUEST_TITLE"));
  for (const rule of ["Include sent mail and replies", "read the original thread", "relative to when the message was sent", "at most ten recent mail threads", "Do not send mail", "reply with exactly NOTHING"]) assert(prompt.includes(rule), rule);
  const since = Date.parse(prompt.match(/Check account activity since ([^ ]+)/)![1]);
  assert(Math.abs(Date.now() - since - 86_400_000) < 10_000);
  pass("due job queues a bounded investigation with timezone, private context boundaries and alert history");

  await run(id);
  assert.equal(scheduled("brain:handleTurn").length, 1);
  const chatId = String(heartbeat().conversationId);
  assert.equal(db.get(chatId)?.pendingTurns, 1);
  pass("an in-flight investigation cannot queue a second turn");

  db.patch(chatId, { pendingTurns: 0 });
  db.insert("runs", { conversationId: chatId, status: "ok", startedAt: Date.now() - 60_000, finishedAt: Date.now(), prompt: "partial source check", steps: 0, toolCalls: [] });
  db.insert("runs", { conversationId: chatId, status: "error", startedAt: Date.now(), prompt: "failed check", steps: 0, toolCalls: [] });
  await run(id);
  const retried = String(scheduled("brain:handleTurn").at(-1)!.text);
  const retriedSince = Date.parse(retried.match(/Check account activity since ([^ ]+)/)![1]);
  assert(Math.abs(Date.now() - retriedSince - 86_400_000) < 10_000);
  pass("rolling lookback survives failures, partial reads and indexing delays");

  const finding = "You cancelled the meeting because you are away this week, but the original invitation is for the week after next. Check the original invitation before sending a correction.";
  await mutate("jobs:finished", { id, result: finding });
  assert.equal(scheduled("notify:deliver").length, 1);
  assert(!db.all("memories").some((memory) => String(memory.text).includes(finding)));
  assert.equal(await rt.runAction("notify:deliver", scheduled("notify:deliver")[0], { internal: true }), false);
  await mutate("jobs:finished", { id, result: finding });
  assert.equal(scheduled("notify:deliver").length, 2);
  pass("a targetless delivery is not marked as alerted and the next check can retry");

  const clock = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false }).split(":").map(Number);
  const minute = clock[0] * 60 + clock[1];
  const time = (offset: number) => { const at = (minute + offset + 1440) % 1440; return `${Math.floor(at / 60).toString().padStart(2, "0")}:${(at % 60).toString().padStart(2, "0")}`; };
  db.patch(install, { claimedAt: Date.now(), ownerChannel: "telegram", ownerExternalId: "4242", quietHours: { start: time(-30), end: time(30) } });
  await rt.runAction("notify:deliver", scheduled("notify:deliver")[1], { internal: true });
  assert(db.all("sent").some((row) => row.heldFor === "quiet" && String(row.text).includes(finding)));
  assert(db.all("memories").some((memory) => String(memory.text).includes(finding)));
  await mutate("jobs:finished", { id, result: `  ${finding.replaceAll(" ", "\n")}  ` });
  assert.equal(scheduled("notify:deliver").length, 2);
  await mutate("jobs:finished", { id, result: "NOTHING" });
  assert.equal(scheduled("notify:deliver").length, 2);
  pass("an accepted finding reaches memory once; whitespace duplicates and NOTHING stay quiet");
  pass("proactive findings use the existing quiet-hours admission path");

  db.patch(install, { quietHours: undefined, homeChannel: "whatsapp", whatsappOwner: "919876543210@s.whatsapp.net" });
  const accepted = "A confirmed calendar clash needs your attention.";
  await mutate("jobs:finished", { id, result: accepted });
  assert.equal(await rt.runAction("notify:deliver", scheduled("notify:deliver").at(-1)!, { internal: true }), true);
  assert(db.all("whatsappOutbox").some((row) => String(row.text).includes(accepted)));
  assert(db.all("memories").some((memory) => String(memory.text).includes(accepted)));
  pass("a successfully queued WhatsApp alert is recorded after acceptance");

  process.env.TELEGRAM_BOT_TOKEN = "123456:proactive-fixture";
  db.patch(install, { homeChannel: "telegram" });
  const failed = "A finding whose Telegram transport fails must be retried.";
  await mutate("jobs:finished", { id, result: failed });
  const attempts = scheduled("notify:deliver").length;
  assert.equal(await rt.runAction("notify:deliver", scheduled("notify:deliver").at(-1)!, { internal: true }), false);
  assert(!db.all("memories").some((memory) => String(memory.text).includes(failed)));
  assert(!db.all("sent").some((row) => String(row.text).includes(failed)));
  await mutate("jobs:finished", { id, result: failed });
  assert.equal(scheduled("notify:deliver").length, attempts + 1);
  pass("a failed transport leaves no deduplication marker and the next check can retry");

  db.patch(chatId, { pendingTurns: 0 });
  await rt.runMutation("pause:set", { key: process.env.DASHBOARD_KEY, paused: true });
  const beforePause = scheduled("brain:handleTurn").length;
  await run(id);
  assert.equal(scheduled("brain:handleTurn").length, beforePause);
  pass("global pause prevents new investigations");

  await rt.stop();
  sql.close();
  sql = new DatabaseSync(join(home, "fixture.sqlite"));
  runtime = new Runtime(sql, schema as never, modules, { storageDir: join(home, "storage") });
  await runtime.stop();
  const beforeRestart = sql.prepare("SELECT count(*) AS n FROM _scheduled WHERE name = 'notify:deliver'").get()!.n;
  await runtime.runMutation("jobs:finished", { id, result: finding }, { internal: true });
  assert.equal(sql.prepare("SELECT count(*) AS n FROM _scheduled WHERE name = 'notify:deliver'").get()!.n, beforeRestart);
  pass("duplicate suppression survives a runtime restart");

  const shared = "The original meeting thread provides additional context. ".repeat(12);
  runtime.store.patch(install, { quietHours: { start: time(-30), end: time(30) } });
  await runtime.runMutation("jobs:finished", { id, result: shared + "The meeting is on Tuesday." }, { internal: true });
  await runtime.runAction("notify:deliver", scheduled("notify:deliver").at(-1)!, { internal: true });
  await runtime.runMutation("jobs:finished", { id, result: shared + "The meeting has moved to Wednesday." }, { internal: true });
  assert.equal(Number(sql.prepare("SELECT count(*) AS n FROM _scheduled WHERE name = 'notify:deliver'").get()!.n), Number(beforeRestart) + 2);
  pass("truncated alert memory never suppresses a materially different long finding");
} catch (error) {
  failure = error instanceof Error ? error.stack : String(error);
  console.error(failure);
} finally {
  await runtime?.stop();
  sql?.close();
  globalThis.fetch = realFetch;
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, "result.json"), JSON.stringify({ passed: !failure, checks, failure, model: "fixture output; no model or live accounts", promptArtifact: "heartbeat-prompt.txt" }, null, 2) + "\n");
}
if (failure) process.exitCode = 1;
