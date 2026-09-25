import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat, sleep } from "../browser";

// bun artifacts/onboarding/run.ts <outDir> <dashboardKey>
// Needs this branch pushed with `convex dev`, `next dev -p 3005`, CONVEX_URL,
// the Convex CLI signed in to the deployment, and a live runner signed in to
// Codex. Uses five Codex turns. It starts from an install made before the
// welcome page existed (onboarding unset), and puts back what it changes:
// the assistant's name, personality and USER.md are saved again as they were
// (the test's versions stay in their history), onboarding is unset again, and
// both chats it opens are deleted.
//
// Ways getting to know each other could fail, and what catches each:
//   1. An existing install is never offered it, or cannot turn it down: the
//      chat page must show the offer, and "Not now" must hide it for good
//      (onboarding "skipped").
//   2. The offer does not lead anywhere: "Get started" must open /welcome and
//      set onboarding "pending".
//   3. A new install does not start there: with onboarding pending, the root
//      address must land on /welcome.
//   4. Answers are lost between steps: the review must hold what was typed on
//      the About you step, the chips picked, and the browser's timezone.
//   5. Saving does not stick: after "Save and meet", onboarding must be done
//      and the name, personality and USER.md saved as the owner's.
//   6. The first chat is empty, or shows the hidden prompt as the owner's
//      message: the chat it lands on must open with the assistant's reply,
//      with no message from the owner and no trace of the hidden prompt, and
//      Activity must list the run as "Welcome greeting", not the prompt.
//   7. The greeting ignores USER.md: it must use the name to call the owner
//      and something from their work.
//   8. The name is only cosmetic: asked its name in a later turn, the
//      assistant must answer with the chosen one, and the sidebar and chat
//      avatar must show it.
//   9. The assistant cannot keep USER.md current, or rewrites it badly: told
//      something lasting and asked to add it, USER.md must gain it, written by
//      the assistant, and still hold what it said before.
//  10. It cannot change its name when asked: the name must change, and the
//      sidebar with it.
//  11. The About you page cannot undo it: it must show the current USER.md,
//      and restoring the owner's version must make it current again.
//  12. Starting over is broken, or "just chat" is: About you must reopen the
//      welcome page with the saved name filled in, and "I'd rather just chat"
//      must open a chat where the assistant speaks first and asks something,
//      again with no message from the owner.
//  13. The welcome page breaks on a phone: at 390px it must not scroll
//      sideways.
//  14. Any page throws: no uncaught errors in the page.

const [outDir, dashboardKey] = process.argv.slice(2);
if (!outDir || !dashboardKey) throw new Error("usage: bun artifacts/onboarding/run.ts <outDir> <dashboardKey>");
mkdirSync(outDir, { recursive: true });

const base = "http://localhost:3005";
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const cli = (fn: string, args: object = {}) => JSON.parse(execFileSync("node", ["node_modules/convex/bin/main.js", "run", fn, JSON.stringify(args)], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }) || "null");
type Persona = { name: string; personality: string; user: string };
const onboarding = (): string => cli("installation:status").onboarding;
const persona = (): Persona => cli("persona:current");
const userHistory = (): Array<{ by: string; text?: string }> => cli("persona:history", { kind: "user" });

const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const turns: Array<{ asked: string; reply: string | null; error: string | null }> = [];
const chats: string[] = [];

const before = { onboarding: onboarding(), persona: persona() };
notes.before = before;
if (before.onboarding !== "offer") throw new Error(`Start from an install with onboarding unset; this one is "${before.onboarding}".`);

const browser = await openChat(base, dashboardKey);
const { evaluate, send } = browser;
const waitFor = (test: string, what: string, ms = 30000) => evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => (${test}) ? resolve(true) : Date.now() - start > ${ms} ? reject(new Error(${JSON.stringify(what)})) : setTimeout(tick, 150); tick(); })`);
const shot = async (name: string) => writeFileSync(join(outDir, name), Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64"));
const click = (selector: string, text?: string) => evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((node) => ${text ? `node.innerText.includes(${JSON.stringify(text)})` : "true"}); if (!el) throw new Error(${JSON.stringify(`nothing to click: ${selector} ${text ?? ""}`)}); el.click(); return true; })()`);
/** Type as a person would, so React sees the change. */
const type = (selector: string, value: string) => evaluate(`(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value").set.call(el, ${JSON.stringify(value)});
  el.dispatchEvent(new Event("input", { bubbles: true }));
  return true;
})()`);
const byLabel = (label: string) => evaluate(`(() => { const l = [...document.querySelectorAll("label")].find((node) => node.innerText.trim() === ${JSON.stringify(label)}); return l ? "#" + CSS.escape(l.htmlFor) : null; })()`);
const fill = async (label: string, value: string) => {
  const selector = await byLabel(label);
  if (!selector) throw new Error(`no field labelled ${label}`);
  await type(selector, value);
};
const path = () => evaluate(`location.pathname`) as Promise<string>;
const chatId = async () => decodeURIComponent((await path()).split("/")[2] ?? "");
const brand = () => evaluate(`document.querySelector(".sidebar .brand")?.innerText.trim() ?? ""`) as Promise<string>;

/** The assistant's reply that opens a chat nobody has written in yet. */
async function firstReply(): Promise<string | null> {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const state = await evaluate(`(() => {
      const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-bubble')];
      return { count: replies.length, last: replies.at(-1)?.innerText ?? null, thinking: !!document.querySelector('.chat-thinking, .chat-streaming'), error: document.querySelector('.chat-turn-error')?.innerText ?? null };
    })()`);
    if (!state.thinking && state.count > 0) return state.last;
    if (!state.thinking && state.error) { notes.firstReplyError = state.error; return null; }
  }
  return null;
}

async function ask(text: string) {
  await type(".chat-composer-box textarea", text);
  const count = await evaluate(`document.querySelectorAll('.chat-turn.from-assistant:not(.pending)').length`);
  await click(".chat-send");
  const deadline = Date.now() + 300000;
  for (;;) {
    await sleep(1500);
    await evaluate(`(() => { const b = document.querySelector('.approval-approve:not(:disabled)'); if (b) b.click(); return true; })()`);
    const state = await evaluate(`(() => {
      const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-bubble')];
      return { count: replies.length, last: replies.at(-1)?.innerText ?? null, thinking: !!document.querySelector('.chat-thinking'), error: document.querySelector('.chat-turn-error')?.innerText ?? null };
    })()`);
    if (!state.thinking && state.count > count) { turns.push({ asked: text, reply: state.last, error: null }); break; }
    if (!state.thinking && state.error) { turns.push({ asked: text, reply: null, error: state.error }); break; }
    if (Date.now() > deadline) { turns.push({ asked: text, reply: null, error: "no reply within 5 minutes" }); break; }
  }
  return turns.at(-1)!;
}

/** What the chat holds, from the server rather than the page. */
async function stored(id: string) {
  const page = await convex.query(api.dashboard.getChatMessages, { key: dashboardKey, id: id as Id<"conversations">, paginationOpts: { numItems: 50, cursor: null } });
  return page.page;
}

try {
  // 1. The offer, and turning it down.
  await waitFor(`document.querySelector(".chat-offer")`, "no onboarding offer on the chat page");
  await shot("offer.png");
  await click(".chat-offer button", "Not now");
  await waitFor(`!document.querySelector(".chat-offer")`, "the offer stayed after Not now");
  checks.offerShownAndDismissed = onboarding() === "skipped";

  // 2. Offered again (as before), then taken up.
  cli("installation:setOnboarding", { state: "offer" });
  await waitFor(`document.querySelector(".chat-offer")`, "the offer did not come back");
  await click(".chat-offer button", "Get started");
  await waitFor(`location.pathname === "/welcome" && document.querySelector(".welcome-card h1")`, "Get started did not open the welcome page");
  checks.getStartedOpensWelcome = onboarding() === "pending";

  // 3. The root lands there while pending.
  await send("Page.navigate", { url: base });
  await waitFor(`location.pathname === "/welcome" && document.querySelector(".welcome-card h1")?.innerText === "Meet your assistant"`, "the root did not open the welcome page");
  checks.rootOpensWelcomeWhenPending = true;

  // Step 1: name and personality.
  await fill("Name", "Juniper");
  await click(".welcome-choice", "Calm & concise");
  await sleep(300);
  checks.previewUsesName = await evaluate(`document.querySelector(".welcome-preview-name")?.innerText === "Juniper"`);
  await shot("welcome-1-assistant.png");
  await click(".welcome-actions button[type=submit]");

  // Step 2: about you.
  await waitFor(`document.querySelector(".welcome-card h1")?.innerText === "About you"`, "step 2 never opened");
  await fill("What should I call you?", "Sam");
  await fill("What do you do?", "I restore vintage bicycles in a small workshop I run.");
  await fill("What does a typical day look like?", "Workshop from 9 to 6, parts hunting online in the evenings.");
  await fill("Who matters to you?", "My sister Maya, who helps at the shop on Saturdays.");
  await click(".segmented button", "Short");
  await click(".welcome-chip", "Reminders");
  await click(".welcome-chip", "Research");
  await fill("Anything I should never do?", "Never email a customer without asking me first.");
  await shot("welcome-2-about-you.png");
  await click(".welcome-actions button[type=submit]");

  // Step 3: the review holds every answer.
  await waitFor(`document.querySelector(".welcome-card h1")?.innerText === "Your USER.md"`, "step 3 never opened");
  const review: string = await evaluate(`document.querySelector("textarea.welcome-md").value`);
  const timezone: string = await evaluate(`Intl.DateTimeFormat().resolvedOptions().timeZone`);
  notes.review = review;
  checks.reviewHoldsAnswers = ["# About Sam", "vintage bicycles", "Maya", "Short and to the point", "- Reminders", "- Research", "Never email a customer", `**Timezone:** ${timezone}`].every((part) => review.includes(part));
  await shot("welcome-3-review.png");
  await click(".welcome-actions button[type=submit]", "Save and meet Juniper");

  // 5–7. Saved, and the greeting.
  await waitFor(`/^\\/chat\\/.+/.test(location.pathname)`, "saving did not open a chat", 60000);
  const welcomeChat = await chatId();
  chats.push(welcomeChat);
  const saved = persona();
  notes.savedPersona = saved;
  checks.savedAsOwner = onboarding() === "done" && saved.name === "Juniper" && saved.personality.startsWith("Calm, brief") && saved.user.includes("vintage bicycles") && userHistory()[0]?.by === "owner";
  const greeting = await firstReply();
  notes.greeting = greeting;
  const greetingStored = await stored(welcomeChat);
  notes.greetingChat = greetingStored.map((message) => ({ role: message.role, text: message.text.slice(0, 300) }));
  checks.greetingArrives = Boolean(greeting);
  checks.noOwnerMessageInGreetingChat = greetingStored.every((message) => message.role !== "user")
    && await evaluate(`document.querySelectorAll(".chat-turn.from-user").length === 0`)
    && !greetingStored.some((message) => message.text.includes("not a message from the owner"));
  checks.greetingUsesUserMd = Boolean(greeting && greeting.includes("Sam") && /bicycl|bike/i.test(greeting));
  const runs = await convex.query(api.dashboard.listRuns, { key: dashboardKey, conversationId: welcomeChat as Id<"conversations"> });
  notes.greetingRun = runs.map((run) => run.prompt);
  checks.activityListsGreetingByLabel = runs.length === 1 && runs[0].prompt === "Welcome greeting";
  checks.nameShownInSidebarAndAvatar = (await brand()).endsWith("Juniper") && await evaluate(`[...document.querySelectorAll(".chat-avatar")].every((node) => node.innerText === "J")`);
  await shot("greeting.png");

  // 8. The name reaches the turn.
  const name = await ask("What's your name, and what do I do for work? One sentence.");
  checks.nameReachesTurns = Boolean(name.reply && name.reply.includes("Juniper") && /bicycl|bike/i.test(name.reply));

  // 9. Keeping USER.md current.
  await ask("Maya just had a baby boy called Leo. Please add that to my USER.md.");
  const afterAdd = persona().user;
  notes.userMdAfterAdd = afterAdd;
  checks.assistantAddsToUserMd = afterAdd.includes("Leo") && userHistory()[0]?.by === "assistant";
  checks.assistantKeepsRestOfUserMd = ["vintage bicycles", "Never email a customer", "Reminders"].every((part) => afterAdd.includes(part));

  // 10. Renamed when asked.
  await ask("Please change your name to Juno.");
  checks.assistantRenamesWhenAsked = persona().name === "Juno";
  await waitFor(`document.querySelector(".sidebar .brand")?.innerText.trim().endsWith("Juno")`, "the sidebar kept the old name").then(() => { checks.sidebarFollowsRename = true; }, () => { checks.sidebarFollowsRename = false; });
  checks.everyTurnReplied = turns.every((turn) => turn.reply && !turn.error);
  await shot("chat-after.png");

  // 11. About you: see it, and restore the owner's version. When the assistant
  // could not write its version (9 fails), one is written here so the page is
  // still tested; the notes say so.
  if (!persona().user.includes("Leo")) {
    cli("persona:writeUser", { text: `${persona().user}\n\n## Family\n\nMaya's son Leo was just born.`, by: "assistant" });
    notes.wroteAssistantVersionForAboutYou = true;
  }
  await send("Page.navigate", { url: `${base}/about` });
  await waitFor(`document.querySelector("#user-md")?.value.includes("Leo")`, "About you did not show the current USER.md");
  checks.aboutShowsCurrent = true;
  await shot("about.png");
  const ownerVersion = userHistory().findIndex((version) => version.by === "owner");
  notes.ownerVersionIndex = ownerVersion;
  await evaluate(`(() => { const rows = [...document.querySelectorAll(".item")].filter((row) => row.querySelector("summary")?.innerText.startsWith("USER.md")); rows[${ownerVersion}].querySelector(".item-side button").click(); return true; })()`);
  await waitFor(`[...document.querySelectorAll("[role=alertdialog] button")].some((b) => b.innerText.includes("Restore"))`, "no restore confirmation");
  await click("[role=alertdialog] button", "Restore");
  await waitFor(`!document.querySelector("#user-md")?.value.includes("Leo")`, "restoring did not change USER.md");
  checks.restoreBringsBackOwnerVersion = !persona().user.includes("Leo") && persona().user.includes("vintage bicycles") && userHistory()[0]?.by === "owner";

  // 12. Start over, and just chat.
  await click("button", "Open the welcome page");
  await waitFor(`location.pathname === "/welcome" && document.querySelector(".welcome-card input")`, "Start over did not open the welcome page");
  checks.startOverPrefillsName = onboarding() === "pending" && await evaluate(`document.querySelector(".welcome-card input").value === ${JSON.stringify(persona().name)}`);
  await click(".welcome-escapes button", "just chat");
  await waitFor(`/^\\/chat\\/.+/.test(location.pathname)`, "just chat did not open a chat", 60000);
  const interviewChat = await chatId();
  chats.push(interviewChat);
  const interview = await firstReply();
  notes.interview = interview;
  const interviewStored = await stored(interviewChat);
  checks.justChatAsksFirst = Boolean(interview && interview.includes("?")) && interviewStored.every((message) => message.role !== "user") && onboarding() === "done";
  await shot("interview.png");

  // 13. A phone.
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Page.navigate", { url: `${base}/welcome` });
  await waitFor(`document.querySelector(".welcome-card h1")`, "welcome did not render on a phone");
  await sleep(500);
  checks.phoneDoesNotScrollSideways = await evaluate(`document.documentElement.scrollWidth <= innerWidth`);
  await shot("welcome-phone.png");

} catch (error) {
  // A step that cannot go on fails the run, with what happened so far kept.
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  notes.turns = turns;
  notes.pageErrors = browser.errors;
  checks.noPageErrors = browser.errors.length === 0;
  browser.close();
  // Put back what the test changed.
  for (const id of chats) await convex.mutation(api.dashboard.deleteChat, { key: dashboardKey, id: id as Id<"conversations"> }).catch((error) => { notes.cleanupError = String(error); });
  cli("persona:writeIdentity", { name: before.persona.name, personality: before.persona.personality, by: "owner" });
  cli("persona:writeUser", { text: before.persona.user, by: "owner" });
  cli("installation:setOnboarding", { state: "offer" });
  const after = { onboarding: onboarding(), persona: persona() };
  notes.restored = after;
  checks.leftAsFound = JSON.stringify(after) === JSON.stringify(before);
}

const result = { ranAt: new Date().toISOString(), checks, notes, passed: Object.values(checks).every(Boolean) };
writeFileSync(join(outDir, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify({ checks, passed: result.passed }, null, 2));
if (!result.passed) process.exit(1);
