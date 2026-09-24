import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat, sleep } from "../browser";

// bun artifacts/permissions/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`; a runner on this branch started with `--dir $E2E_WORKDIR`
// (any policy: the test sets it) and signed in to Codex, which the reviewer uses;
// an install claimed from Telegram; CONVEX_URL; E2E_WORKDIR; TELEGRAM_WEBHOOK_SECRET,
// the deployment's webhook secret (the Keys page, or `pnpm exec convex env get`);
// and the Convex CLI signed in to the deployment, to queue commands and read the owner id.
//
// Nothing is sent to Telegram. The test turns the Computer page's "Ask me on
// Telegram too" off, so no prompt is sent and there is no message to edit, and
// it plays Telegram itself: it posts callback_query updates to the Convex
// webhook, as Telegram would, with the secret header and the owner's id. The
// only call to Telegram is answerCallbackQuery for the made-up query id, which
// Telegram rejects without showing anything to anyone.
//
// Commands are queued straight to the runner (runner:enqueue), not asked of
// Codex, so every request is exactly the same text each time.
//
// Ways this can fail, and what is checked:
//  1. A forged tap is obeyed: a wrong secret must get 403, and a tap from
//     anyone but the stored owner must leave the request pending.
//  2. The button data is too long for Telegram (64 bytes) or not parsed.
//  3. The owner's tap is recorded but the runner never hears it: the command
//     must run and write its file, and the request must say decidedBy telegram.
//  4. A second answer overrides the first: Decline after Approve changes nothing.
//  5. Always allow saves nothing, or something broader than the exact command
//     in its folder, or the same request is still asked: the rule must be the
//     exact command, the repeat must run by that rule with no pending request,
//     and the rule's use count must go up.
//  6. The policy chosen in the dashboard does not reach the runner: it is set
//     with the Computer page's select and read back.
//  7. Rules do not come first under "review": the saved command must still be
//     allowed by the rule, not the reviewer.
//  8. The reviewer is broken (errors and timeouts ask the owner), or clears
//     everything: a read-only listing must be cleared with a "clear" verdict,
//     and deleting a file must wait for the owner with a "caution" verdict.
//  9. The dashboard cannot answer, or does not show why it asks: the caution
//     card must show the reviewer's verdict, Decline must refuse the command,
//     and the file must still be there.
// 10. A Telegram prompt went out during the test: no request made here may have
//     a Telegram message recorded.
// 11. The test changes the owner's setup: policy and the Telegram setting are
//     restored, and the rule and file it made are removed.
const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const workdir = process.env.E2E_WORKDIR!;
const secret = process.env.TELEGRAM_WEBHOOK_SECRET!;
if (!workdir || !secret) throw new Error("Set E2E_WORKDIR and TELEGRAM_WEBHOOK_SECRET.");
const site = process.env.CONVEX_SITE_URL ?? process.env.CONVEX_URL!.replace(".convex.cloud", ".convex.site");
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const cli = (...args: string[]) => execFileSync("node", ["node_modules/convex/bin/main.js", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const convexRun = (fn: string, args: object) => JSON.parse(cli("run", fn, JSON.stringify(args)).trim() || "null");
const table = (name: string) => JSON.parse(cli("data", name, "--limit", "50", "--order", "desc", "--format", "jsonArray"));

const until = async <T>(check: () => Promise<T | undefined | null | false>, what: string, ms = 120_000): Promise<T> => {
  const start = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - start > ms) {
      await putBack();
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(500);
  }
};

// Every command the test queues names this, so its leftovers can be found.
const nonce = randomUUID().slice(0, 8);
const file = `perry-e2e-${nonce}.txt`;
const filePath = join(workdir, file);
const made: Id<"approvals">[] = [];

/** Put the owner's setup back, and decline anything of ours still waiting, which would hold the runner for ten minutes. */
let putBackDone = false;
async function putBack() {
  if (putBackDone) return;
  putBackDone = true;
  for (const item of await convex.query(api.approvals.pending, { key: dashboardKey })) {
    if (item.title.includes(nonce)) await convex.mutation(api.approvals.decide, { key: dashboardKey, id: item.id, approved: false });
  }
  for (const rule of await convex.query(api.approvals.rules, { key: dashboardKey })) {
    if (rule.command?.includes(nonce)) await convex.mutation(api.approvals.deleteRule, { key: dashboardKey, id: rule.id });
  }
  await convex.mutation(api.dashboard.setRunnerPolicy, { key: dashboardKey, runnerId: runner!.id, policy: runner!.policy });
  await convex.mutation(api.dashboard.setTelegramApprovals, { key: dashboardKey, enabled: before.telegramApprovals.enabled });
  rmSync(filePath, { force: true });
}

// Which runner, which owner, and what to put back afterwards.
const { name } = await convex.mutation(api.runner.checkIn, { token: runnerToken });
const owner = table("installation")[0];
if (!owner?.claimedAt || owner.ownerChannel !== "telegram") throw new Error("This test needs an install claimed from Telegram.");
const ownerId = String(owner.ownerExternalId);
const compute = () => convex.query(api.dashboard.getCompute, { key: dashboardKey });
const before = await compute();
const runner = before.runners.find((item) => item.name === name && !item.revoked);
if (!runner) throw new Error(`runner ${name} is not listed`);
await convex.mutation(api.dashboard.setTelegramApprovals, { key: dashboardKey, enabled: false });

const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const screenshot = async (png: string) => {
  const shot = await send("Page.captureScreenshot", { format: "png" });
  writeFileSync(join(outDir, png), Buffer.from(shot.data, "base64"));
};
await evaluate(`[...document.querySelectorAll('.chat-nav-grid a')].find((b) => b.innerText.trim().startsWith('Computer')).click(); true`);

/** Choose a policy with the runner's select on the Computer page, and wait for Convex to have it. */
async function choosePolicy(policy: "ask" | "review" | "trust") {
  await evaluate(`new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      const item = [...document.querySelectorAll('.item')].find((el) => el.querySelector('strong')?.innerText === ${JSON.stringify(name)} && el.querySelector('select.runner-policy'));
      if (!item) return Date.now() - start > 30000 ? reject(new Error('runner select never rendered')) : setTimeout(tick, 250);
      const select = item.querySelector('select.runner-policy');
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(policy)});
      select.dispatchEvent(new Event('change', { bubbles: true }));
      resolve(true);
    };
    tick();
  })`);
  return await until(async () => (await compute()).runners.find((item) => item.id === runner!.id)?.policy === policy && policy, `policy ${policy}`, 15_000);
}

/** Be Telegram: post a button tap to the webhook. */
async function tap(id: string, choice: "y" | "n" | "a", from = ownerId, token = secret) {
  const data = `ap:${id}:${choice}`;
  const response = await fetch(`${site}/telegram`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": token },
    body: JSON.stringify({
      update_id: Math.floor(Math.random() * 1e9),
      callback_query: {
        id: `e2e-${randomUUID()}`,
        from: { id: Number(from), is_bot: false, first_name: "e2e" },
        data,
        message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: Number(ownerId), type: "private" } },
      },
    }),
  });
  return { status: response.status, bytes: Buffer.byteLength(data) };
}

const enqueue = (command: string): Id<"commands"> =>
  convexRun("runner:enqueue", { runnerId: runner.id, kind: "exec", operationId: `e2e-permissions-${randomUUID()}`, command });
const commandRow = (id: Id<"commands">) => convexRun("runner:getCommand", { commandId: id });
const finished = (id: Id<"commands">) => until(async () => { const row = commandRow(id); return row && !["queued", "running"].includes(row.status) && row; }, "the command to finish");
const pendingFor = (title: string) => until(async () => (await convex.query(api.approvals.pending, { key: dashboardKey })).find((item) => item.title === title), `a request for ${title}`);
const latest = async (title: string) => (await convex.query(api.approvals.recent, { key: dashboardKey })).find((item) => item.title === title);
const rulesFor = async (command: string) => (await convex.query(api.approvals.rules, { key: dashboardKey })).filter((rule) => rule.command === command);

// 1. Ask: approve from "Telegram".
await choosePolicy("ask");
const write = `echo approved-by-telegram> ${file}`;
const first = enqueue(write);
const asked = await pendingFor(write);
made.push(asked.id);
const forgedSecret = await tap(asked.id, "y", ownerId, `${secret}x`);
const stranger = await tap(asked.id, "y", String(Number(ownerId) + 1));
await sleep(2000);
const stillPending = (await latest(write))?.status === "pending";
const owners = await tap(asked.id, "y");
const firstRun = await finished(first);
const late = await tap(asked.id, "n");
await sleep(2000);
const approved = await latest(write);
const written = existsSync(filePath) ? readFileSync(filePath, "utf8").trim() : null;

// 2. Always allow, then the same request again.
const always = `echo always-${nonce}`;
const second = enqueue(always);
const alwaysAsked = await pendingFor(always);
made.push(alwaysAsked.id);
await sleep(1500);
await screenshot("approval-card.png");
const alwaysTap = await tap(alwaysAsked.id, "a");
const secondRun = await finished(second);
const [rule] = await until(async () => { const found = await rulesFor(always); return found.length > 0 && found; }, "the rule");
let askedAgain = false;
const third = enqueue(always);
const watch = setInterval(() => void convex.query(api.approvals.pending, { key: dashboardKey }).then((items) => { if (items.some((item) => item.title === always)) askedAgain = true; }), 300);
const thirdRun = await finished(third);
clearInterval(watch);
const byRule = await latest(always);
if (byRule) made.push(byRule.id);
const ruleAfter = (await rulesFor(always))[0];

// 3. Review: rules still first, the routine is cleared, the risky waits and is declined in the dashboard.
await choosePolicy("review");
const fourth = enqueue(always);
const fourthRun = await finished(fourth);
const ruleUnderReview = await latest(always);
if (ruleUnderReview) made.push(ruleUnderReview.id);

const list = `dir /b ${file}`;
const listRun = await finished(enqueue(list));
const cleared = await latest(list);
if (cleared) made.push(cleared.id);

const remove = `del ${file}`;
const removal = enqueue(remove);
const caution = await pendingFor(remove);
made.push(caution.id);
const card = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const card = [...document.querySelectorAll('.approval')].find((el) => el.querySelector('.approval-what')?.innerText === ${JSON.stringify(remove)});
    if (card) return resolve({ review: card.querySelector('.approval-review')?.innerText ?? null, buttons: [...card.querySelectorAll('button')].map((b) => b.innerText) });
    if (Date.now() - start > 30000) return reject(new Error('the caution card never appeared'));
    setTimeout(tick, 250);
  };
  tick();
})`);
await screenshot("reviewer-caution.png");
await evaluate(`[...[...document.querySelectorAll('.approval')].find((el) => el.querySelector('.approval-what')?.innerText === ${JSON.stringify(remove)}).querySelectorAll('button')].find((b) => b.innerText === 'Decline').click(); true`);
const removalRun = await finished(removal);
const declined = await latest(remove);
const survived = existsSync(filePath);
await sleep(1000);
await evaluate(`window.scrollTo(0, document.body.scrollHeight); document.querySelector('.workspace-scroll')?.scrollTo(0, 1e6); true`);
await sleep(500);
await screenshot("rules-and-recent.png");

// 4. Nothing reached Telegram, then put everything back.
const approvals = table("approvals").filter((row: { _id: string }) => made.includes(row._id as Id<"approvals">));
const telegramMessages = approvals.filter((row: { telegramMessageId?: number }) => row.telegramMessageId !== undefined).length;
await putBack();
const restored = await compute();
const ruleGone = (await rulesFor(always)).length === 0;

const checks = {
  forgedSecretRefused: forgedSecret.status === 403,
  strangerIgnored: stranger.status === 200 && stillPending,
  buttonDataFits: owners.bytes <= 64,
  ranAfterTelegramApproval: firstRun.status === "done" && written === "approved-by-telegram",
  decidedByTelegram: approved?.status === "approved" && approved.decidedBy === "telegram",
  firstAnswerWon: late.status === 200 && approved?.status === "approved",
  alwaysAllowRan: alwaysTap.status === 200 && secondRun.status === "done",
  exactRuleSaved: rule.kind === "command" && rule.command === always && !rule.prefix && resolve(rule.cwd ?? "").toLowerCase() === resolve(workdir).toLowerCase(),
  repeatAllowedByRule: thirdRun.status === "done" && !askedAgain && byRule?.status === "auto" && byRule.decidedBy === "rule" && byRule.ruleId === rule.id,
  ruleUsesCounted: ruleAfter?.uses === 1,
  ruleBeforeReviewer: fourthRun.status === "done" && ruleUnderReview?.decidedBy === "rule" && !ruleUnderReview.review,
  reviewerClearedRoutine: listRun.status === "done" && cleared?.decidedBy === "reviewer" && cleared.review?.verdict === "clear",
  reviewerCautionedDelete: caution.review?.verdict === "caution" && typeof card.review === "string" && card.review.includes("caution"),
  declinedInDashboard: removalRun.status === "denied" && declined?.status === "declined" && declined.decidedBy === "dashboard" && survived,
  noTelegramMessages: approvals.length === made.length && telegramMessages === 0,
  restored: ruleGone && !existsSync(filePath) && restored.runners.find((item) => item.id === runner.id)?.policy === runner.policy
    && restored.telegramApprovals.enabled === before.telegramApprovals.enabled,
  noPageErrors: errors.length === 0,
};
const pass = Object.values(checks).every(Boolean);
const result = {
  ranAt: new Date().toISOString(),
  runner: name,
  checks,
  requests: { approved, byRule, ruleUnderReview, cleared, caution: { ...caution, card }, declined },
  rule: ruleAfter,
  commands: { first: firstRun.status, second: secondRun.status, third: thirdRun.status, fourth: fourthRun.status, list: listRun.status, removal: removalRun.status },
  pageErrors: errors,
  pass,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
