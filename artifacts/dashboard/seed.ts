import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A lived-in Perry for the dashboard suite, made only through the backend's
 * own functions (the admin endpoint the perry CLI uses): chats with real
 * Markdown, one pinned, one waiting on an approval, a schedule with news,
 * plans in every state, a goal, a watch that fired, and memories.
 *
 * bun artifacts/dashboard/seed.ts <base> <key> <perryHome>  seeds a running server by hand.
 */

export type Seeded = {
  pinnedChat: string;
  approvalChat: string;
  approvalId: string;
  jobChat: string;
  blockedTask: string;
  failedTask: string;
  watch: string;
  chats: string[];
};

export function caller(base: string, key: string) {
  return async function call<T>(path: string, args: object = {}, admin = true): Promise<T> {
    const response = await fetch(`${base}/api/backend/${admin ? "admin" : "call"}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...(admin ? { "x-perry-key": key } : {}) },
      body: JSON.stringify({ path, args }),
    });
    const body = await response.json() as { value?: T; error?: string };
    if (body.error) throw new Error(`${path}: ${body.error}`);
    return body.value as T;
  };
}

const LISBON = `Here's a plan that keeps the mornings slow and the evenings free.

## Thursday
- **Morning:** Alfama on foot, then the Miradouro de Santa Luzia before the tour groups.
- **Afternoon:** Tram 28 is packed after 11, so walk to *Graça* instead.
- **Evening:** Dinner at 20:30, which is early for Lisbon.

## Friday
1. Belém by train from Cais do Sodré (7 minutes, every 20).
2. Pastéis at the original shop; the queue moves fast.
3. MAAT for the roof, not the exhibits.

| Day | Booked | Cost |
| --- | --- | --- |
| Thursday | Dinner | €64 |
| Friday | Train | €4.30 |

I saved the dinner confirmation as \`lisbon-dinner.pdf\`. Want me to put both days on your calendar?`;

const SCRIPT = `Done. This moves anything older than 30 days into an archive folder and leaves the rest:

\`\`\`bash
mkdir -p ~/Downloads/archive
find ~/Downloads -maxdepth 1 -type f -mtime +30 -exec mv {} ~/Downloads/archive/ \\;
\`\`\`

It found **212 files** (3.1 GB). I need your go-ahead to run it, since it touches your files.`;

export async function seed(base: string, key: string, home: string): Promise<Seeded> {
  const call = caller(base, key);
  const pub = <T>(path: string, args: object = {}) => call<T>(path, { key, ...args }, false);

  await call("installation:setOnboarding", { state: "done" });
  await call("persona:writeIdentity", { name: "Perry", personality: "Calm, brief and to the point.", by: "owner" });
  await call("persona:writeUser", { text: "# About Sam\n\n- **Call them:** Sam\n\n## Work\n\nDesigns developer tools.\n", by: "owner" });

  const chat = async (title: string, turns: Array<[string, string]>) => {
    const id = await pub<string>("dashboard:createChat");
    const doc = await call<{ threadId: string }>("conversations:getWebById", { id });
    await call("agentStore:saveMessages", {
      threadId: doc.threadId,
      userId: "web:dashboard",
      messages: turns.flatMap(([user, assistant]) => [{ role: "user", content: user }, { role: "assistant", content: assistant }]),
    });
    await pub("dashboard:renameChat", { id, title });
    // Opened once, so only a reply after this counts as new.
    await pub("dashboard:markChatSeen", { id });
    return id;
  };

  const chats: string[] = [];
  for (const [title, question, answer] of [
    ["Gift ideas for Maya", "Maya turns 30 next week. Ideas under €100?", "Three that fit what you've told me about her: a pottery class for two, a good film camera, or the ceramics book she mentioned in March."],
    ["Summarise the design review", "Summarise yesterday's design review notes.", "**Decided:** ship the new sidebar behind a flag.\n\n**Open:** whether search belongs in the palette or the header."],
    ["Gym plan", "Make me a three-day gym plan.", "Monday legs, Wednesday push, Friday pull. Each is 45 minutes, with the heavy lift first."],
  ] as const) chats.push(await chat(title, [[question, answer]]));

  const pinnedChat = await chat("Plan the Lisbon trip", [["Plan two days in Lisbon for Thursday and Friday.", LISBON]]);
  await pub("dashboard:setChatPinned", { id: pinnedChat, pinned: true });

  const approvalChat = await chat("Clean up my downloads", [["My downloads folder is a mess. Tidy it up.", SCRIPT]]);
  const runner = JSON.parse(readFileSync(join(home, "runner.json"), "utf8")) as { token: string; dir?: string };
  const approval = await call<{ id: string }>("approvals:request", {
    token: runner.token,
    kind: "command",
    title: "find ~/Downloads -maxdepth 1 -type f -mtime +30 -exec mv {} ~/Downloads/archive/ \\;",
    cwd: "~/Downloads",
    conversationId: approvalChat,
  }, false);

  // A schedule that ran this morning and has news.
  const job = await call<{ id: string }>("jobs:create", { name: "Morning briefing", schedule: "0 8 * * 1-5", prompt: "Summarise my calendar and anything urgent in email." });
  const thread = await call<string>("agentStore:createThread", { userId: "web:dashboard", title: "Morning briefing" });
  await call("jobs:chatFor", { id: job.id, threadId: thread });
  const briefing = "Three meetings today; the 14:00 with Priya moved to 15:30. One email needs you: the venue wants a deposit by Friday.";
  await call("agentStore:saveMessages", { threadId: thread, userId: "web:dashboard", messages: [{ role: "assistant", content: briefing }] });
  await call("jobs:finished", { id: job.id, result: briefing });
  const jobs = await pub<{ jobs: Array<{ id: string; chatId?: string }> }>("jobs:listForDashboard");
  const jobChat = jobs.jobs.find((item) => item.id === job.id)!.chatId!;
  await call("conversations:finishWebTurn", { id: jobChat });

  // Plans: one working, one blocked on a question, one done, one failed.
  const task = async (title: string, steps: Array<[string, "pending" | "active" | "done" | "skipped"]>, update?: object) => {
    const id = await call<string>("work:createTask", { title, prompt: title });
    await call("work:setPlan", { taskId: id, plan: steps.map(([stepTitle, status]) => ({ title: stepTitle, status })) });
    if (update) await call("work:updateTask", { taskId: id, ...update });
    return id;
  };
  await task("Compare three standing desks", [["Shortlist desks under €600", "done"], ["Read the long-term reviews", "active"], ["Write up the trade-offs", "pending"]]);
  const blockedTask = await task("Book the Lisbon flights", [["Find flights for Thursday morning", "done"], ["Pick seats", "active"], ["Pay and save the confirmation", "pending"]],
    { status: "blocked", question: "The 07:10 is €40 cheaper but lands at 09:05. Take it, or the 10:30?" });
  await task("Renew the passport photos", [["Find a photo booth nearby", "done"], ["Book a slot", "done"]], { status: "done", result: "Booked for Saturday at 11:00, at the booth in the station." });
  const failedTask = await task("Export last year's receipts", [["Sign in to the bank", "done"], ["Download the statements", "active"]],
    { status: "failed", error: "The bank's export page asked for a one-time code, and none was available." });

  await call("work:createGoal", { title: "Run a half marathon in May", description: "From 5 km to 21 km in sixteen weeks.", milestones: ["Run 10 km without stopping", "Sign up for the race", "Long run of 18 km"] });

  const watch = await call<string>("work:createMonitor", { title: "Leica Q3 back in stock", url: "https://example.com/leica-q3", condition: "contains", value: "In stock", intervalMinutes: 60 });
  await call("work:recordCheck", { id: watch, observation: "The page now says: In stock, ships in 2 days.", fired: true, failed: false });

  for (const [text, kind] of [
    ["Sam takes their coffee black, no sugar.", "profile"],
    ["Sam's partner is Maya; her birthday is 14 October.", "profile"],
    ["Decided to ship the new sidebar behind a flag.", "core"],
    ["Booked passport photos for Saturday at 11:00.", "daily"],
  ] as const) await call("memories:add", { text, tags: [], source: "e2e", kind, origin: "owner" });

  return { pinnedChat, approvalChat, approvalId: approval.id, jobChat, blockedTask, failedTask, watch, chats };
}

if (import.meta.main) {
  const [base, key, home] = process.argv.slice(2);
  if (!base || !key || !home) throw new Error("usage: bun artifacts/dashboard/seed.ts <base> <key> <perryHome>");
  console.log(JSON.stringify(await seed(base, key, home), null, 2));
}
