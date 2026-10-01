import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sleep } from "../browser";

/**
 * A fresh Perry for an end-to-end check, and the seed the fewer-boxes check
 * gives it, so other checks (artifacts/settings-sections) see the same rows.
 *
 * startPerry: the production build in `repo` (`pnpm build` first) on a free
 * port, a PERRY_HOME in PERRY_E2E_HOMES (else the temp folder), no Telegram,
 * no Composio, and no Codex or Claude: CODEX_HOME and CLAUDE_CONFIG_DIR point
 * into the test's home, and the runner is played by its calls, checking in
 * every 20 seconds signed in to Codex on ChatGPT Plus.
 *
 * seed: artifacts/ui-consistency's (a reply with a checklist, a failed run,
 * memories, to-dos, a schedule that ran, a failed update, an approval and a
 * decided one, a skill, a project), plus a person, a login, a goal, a watch
 * and a task with a question.
 */

export type Perry = Awaited<ReturnType<typeof startPerry>>;

const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });

export async function startPerry({ repo, key, name }: { repo: string; key: string; name: string }) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const homes = process.env.PERRY_E2E_HOMES ?? tmpdir();
  mkdirSync(homes, { recursive: true });
  const home = mkdtempSync(join(homes, `perry-${name}-`));
  mkdirSync(join(home, "skills", "weekly-review"), { recursive: true });
  writeFileSync(join(home, "skills", "weekly-review", "SKILL.md"), "---\nname: weekly-review\ndescription: Writes the owner's weekly review the way they like it.\n---\n\nStart with what shipped, then what slipped.\n");

  const env: NodeJS.ProcessEnv = {
    ...process.env, PERRY_HOME: home, PERRY_PORT: String(port), DASHBOARD_KEY: key, NODE_ENV: "production",
    // Never the owner's accounts: no engine here has a sign-in.
    CODEX_HOME: join(home, "codex-home"), CLAUDE_CONFIG_DIR: join(home, "claude-home"),
  };
  for (const variable of Object.keys(env)) if (variable.startsWith("CONVEX") || variable.startsWith("TELEGRAM") || variable === "COMPOSIO_API_KEY" || variable === "GEMINI_API_KEY" || variable === "ELECTRON_RUN_AS_NODE" || variable === "PERRY_URL") delete env[variable];
  mkdirSync(env.CODEX_HOME!, { recursive: true });
  mkdirSync(env.CLAUDE_CONFIG_DIR!, { recursive: true });
  let log = "";
  const server: ChildProcess = spawn("node", [join(repo, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], { cwd: repo, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  server.stdout?.on("data", (chunk: Buffer) => { log += chunk; });
  server.stderr?.on("data", (chunk: Buffer) => { log += chunk; });

  async function call<T>(path: string, callArgs: object = {}): Promise<T> {
    const response = await fetch(`${base}/api/backend/admin`, { method: "POST", headers: { "content-type": "application/json", "x-perry-key": key }, body: JSON.stringify({ path, args: callArgs }) });
    const body = await response.json() as { value?: T; error?: string };
    if (body.error) throw new Error(`${path}: ${body.error}`);
    return body.value as T;
  }
  async function until(test: () => Promise<unknown> | unknown, what: string, seconds = 30) {
    for (let i = 0; i < seconds * 4; i++) {
      if (await Promise.resolve().then(test).catch(() => false)) return;
      await sleep(250);
    }
    throw new Error(`timed out: ${what}`);
  }
  /** Whether `test` comes true within `seconds`, without throwing. */
  const soon = (test: () => Promise<unknown> | unknown, seconds = 8) => until(test, "", seconds).then(() => true, () => false);

  let heartbeat: ReturnType<typeof setInterval> | null = null;
  const stop = async () => {
    if (heartbeat) clearInterval(heartbeat);
    if (process.platform === "win32" && server.pid) spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], { stdio: "ignore" });
    else server.kill();
    await sleep(1500);
    try { rmSync(home, { recursive: true, force: true }); } catch {}
  };

  await until(() => fetch(`${base}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 120);
  await call("dashboard:skipOnboarding", { key }).catch(() => {});
  const runnerJson = join(home, "runner.json");
  await until(() => existsSync(runnerJson), "the server to connect this computer", 60);
  const token = (JSON.parse(readFileSync(runnerJson, "utf8")) as { token: string }).token;
  const workdir = join(home, "work", "a-long-folder-name-that-the-row-cuts-off", "and-one-more-level-for-good-measure");
  const online = async () => {
    await call("runner:checkIn", { token, platform: "win32", hostname: "E2E", workdir });
    await call("codex:reportAccount", { token, available: true, authMode: "chatgpt", planType: "plus" }).catch(() => {});
  };
  await online();
  heartbeat = setInterval(() => void online().catch(() => {}), 20_000);

  return { base, key, home, token, workdir, call, until, soon, stop, log: () => log };
}

const CHECKLIST_REPLY = `Here's the week, with what's done ticked:

- [x] Book the dentist
- [x] Send the invoice to Priya
- [ ] Renew the passport photos
- [ ] Call Sam about Saturday

| Day | Plan | Time |
| --- | --- | --- |
| Monday | Gym, then the design review | 07:30 |
| Wednesday | Dentist | 14:00 |
| Friday | Weekly review | 16:00 |

Want me to put the passport photos on your list?`;

/** The fewer-boxes seed. What could not be seeded is noted in `notes`, not thrown. */
export async function seed({ call, until, token, workdir, key }: Perry, notes: Record<string, unknown>) {
  const KEY = key;
  const project = await call<string>("projects:create", { key: KEY, name: "Kitchen renovation" });
  const chat = async (title: string) => {
    const id = await call<string>("dashboard:createChat", { key: KEY });
    await call("dashboard:renameChat", { key: KEY, id, title }).catch(() => {});
    return id;
  };
  const turn = async (id: string, text: string, finish: { response?: string; error?: string; spans?: object[] }) => {
    await call("dashboard:sendChat", { key: KEY, id, text });
    let queued: { _id: string } | undefined;
    await until(async () => { queued = (await call<Array<{ _id: string; conversationId: string }>>("codex:queuedTurns", { token })).find((item) => item.conversationId === id); return Boolean(queued); }, "the turn to queue", 30);
    await call("codex:claimTurn", { token, id: queued!._id });
    if (finish.spans) await call("codex:traceTurn", { token, id: queued!._id, spans: finish.spans, steps: 3, usage: { inputTokens: 18_204, cachedInputTokens: 12_000, outputTokens: 912 } });
    await call("codex:finishTurn", { token, id: queued!._id, ...(finish.response ? { response: finish.response, model: "gpt-6-luna" } : {}), ...(finish.error ? { error: finish.error } : {}) });
  };

  const planChat = await chat("Plan my week");
  const receiptsChat = await chat("Export last year's receipts");
  const memoryChat = await chat("Coffee order");
  const coffee = await call<{ id?: string }>("memories:add", { text: "Sam takes their coffee black, no sugar.", tags: [], source: "e2e", kind: "profile", origin: "owner" });
  await call("memories:add", { text: "In this chat, answers stay under three lines.", tags: [], source: "e2e", kind: "core", origin: "owner", conversationId: memoryChat });
  await call("memories:add", { text: "The kitchen tiles are the matte green ones from Porto.", tags: [], source: "e2e", kind: "core", origin: "owner", projectId: project });
  await call("memories:add", { text: "Prefers trains to flights for trips under six hours.", tags: [], source: "dreaming", kind: "core", origin: "owner" });
  await call("memories:add", { text: "Booked passport photos for Saturday at 11:00.", tags: [], source: "e2e", kind: "daily", origin: "owner" });

  const started = Date.now() - 40_000;
  await turn(planChat, "$weekly-review Plan my week, and tick off what's already done.", {
    response: `${CHECKLIST_REPLY}\nmemories: ${coffee.id}`,
    spans: [
      { callId: "c1", kind: "command", name: "Get-Content calendar.ics", status: "ok", startedAt: started, durationMs: 1_800, input: "Get-Content C:\\Users\\sam\\calendar.ics | Select-String 'DTSTART'", output: "DTSTART:20261002T083000" },
      { callId: "c2", kind: "fileChange", name: "notes/week.md", status: "ok", startedAt: started + 2_000, durationMs: 400, input: "notes/week.md", output: "Added the week's plan." },
    ],
  });
  await turn(receiptsChat, "Export last year's receipts from the bank.", { error: "The bank's export page asked for a one-time code, and none was available." });

  const today = new Date();
  const at = (days: number, hours: number, minutes = 0) => { const d = new Date(today); d.setDate(d.getDate() + days); d.setHours(hours, minutes, 0, 0); return d.getTime(); };
  await call("todos:add", { key: KEY, title: "Stretch", dueAt: at(1, 11), repeat: "0 11 * * *" });
  await call("todos:add", { key: KEY, title: "Water the plants", dueAt: Date.now() + 2 * 3_600_000 });
  await call("todos:add", { key: KEY, title: "Weekly review", dueAt: at(2, 16), repeat: "0 16 * * 5" });
  const done = await call<string>("todos:add", { key: KEY, title: "Send the invoice to Priya" });
  await call("todos:setDone", { key: KEY, id: done, done: true });

  const job = await call<{ id: string }>("jobs:create", { name: "Morning briefing", schedule: "0 8 * * 1-5", prompt: "Summarise my calendar and anything urgent in email." });
  await call("jobs:trigger", { id: job.id });
  await call("jobs:finished", { id: job.id, result: "Three meetings today; the 14:00 with Priya moved to 15:30." });

  await call("updates:finished", { result: {
    id: "e2e-update", by: "nightly", at: Date.now() - 3 * 3_600_000, ok: false, from: "6fb9d92", to: "429446f",
    error: "pnpm install could not reach the registry.", log: "step 1: ok\nstep 2: ERR_PNPM_META_FETCH_FAIL",
  } });

  await call("approvals:request", { token, kind: "command", title: "Remove-Item -Recurse .\\build-cache", cwd: join(workdir, "site"), conversationId: planChat });
  const old = await call<{ id: string }>("approvals:request", { token, kind: "command", title: "git push origin main --force-with-lease", cwd: workdir });
  await call("approvals:decide", { key: KEY, id: old.id, approved: false });

  // A person to brief, a login, a goal, a watch, and a task waiting on a question.
  await call("contacts:learn", { items: [{ channel: "whatsapp", externalId: "15550001111@s.whatsapp.net", kind: "person", name: "Datta" }] });
  // Allowed, as the owner's yes makes him: People lists only who Perry talks with, or is asked about.
  const datta = await call<{ _id: string }>("contacts:byChat", { channel: "whatsapp", externalId: "15550001111@s.whatsapp.net" });
  await call("contacts:decided", { contactId: datta._id, kind: "contact", approved: true });
  await call("dashboard:saveToVault", { key: KEY, label: "Netflix", url: "https://www.netflix.com/login", username: "sam@example.com", value: "e2e-not-a-password" });
  await call("dashboard:saveGoal", { key: KEY, title: "Run a half marathon by March", description: "", milestones: [{ title: "Run 5 km without stopping", done: true }, { title: "Run 10 km", done: false }] }).catch((error) => { notes.goalSeed = String(error); });
  await call("dashboard:saveMonitor", { key: KEY, title: "Headphones back in stock", url: "https://example.com/headphones", condition: "contains", value: "In stock", intervalMinutes: 60 }).catch((error) => { notes.watchSeed = String(error); });
  const task = await call<string>("tasks:queue", { title: "Compare three flats near work", prompt: "Find three flats near the office." });
  await sleep(1500);
  await call("work:updateTask", { taskId: task, status: "blocked", question: "Is ₹40,000 a month the most you'd pay, or is that with the deposit spread out?" }).catch((error) => { notes.taskSeed = String(error); });

  return { project, planChat, receiptsChat, memoryChat };
}
