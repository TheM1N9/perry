/**
 * Issue #49's end-to-end check: a web chat turn answered by a runner on this
 * machine, whatever its OS. Run it once on macOS, once on Linux (and on Windows
 * to compare); each run writes artifacts/multi-platform/<os>/result.json.
 *
 *   CONVEX_URL=<deployment url> DASHBOARD_KEY=<key> RUNNER_TOKEN=<token> \
 *     [MEDIA_BASE=http://localhost:3000] bun artifacts/multi-platform/run.ts
 *
 * RUNNER_TOKEN is a fresh token from `pnpm run connect -- --token-only`. Codex
 * must be installed and signed in on this machine. MEDIA_BASE, the dashboard
 * (`pnpm run dev`) on this same machine, adds the check that a shared file is
 * served. The script starts its own runner, without a terminal and without
 * --auto, so approvals go to the dashboard as they do for a background service,
 * and gives it a throwaway PERRY_HOME and workspace; it does not touch
 * ~/.perry. The chat it makes is kept, for a look in the dashboard.
 *
 * Ways it could fail on a given OS, and what is checked for each:
 *
 *   - The runner does not start, or never connects                 → runner.connected
 *   - Codex does not start, or is not signed in (`codex` not found,
 *     a .cmd that needs a shell, a bare PATH)                        → codex, reply arrives
 *   - The turn goes to some other runner                             → turns ran on this runner
 *   - Codex is told the wrong OS or shell                            → reply names this OS
 *   - A shell command fails in this OS's shell, or its output is lost → a command span ran ok
 *   - The sandbox refuses a write inside the workspace (Seatbelt,
 *     bubblewrap/Landlock, the Windows token), or a path with a space
 *     or non-ASCII breaks it                                         → file made in the workspace
 *   - share_file rejects a POSIX path, or misnames a unicode file    → reply carries the file
 *   - The dashboard cannot serve that file from this disk            → media served (MEDIA_BASE)
 *   - A write outside the workspace is not fenced, never asks, or
 *     asks only in a terminal that is not there                      → approval pending in the dashboard
 *   - An approved request does not run, or a declined one does       → approved file made, declined not
 *   - The runner does not hear the dashboard's answer                → runner log names both answers
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, hostname, release, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";

const { CONVEX_URL, DASHBOARD_KEY: key, RUNNER_TOKEN: token, MEDIA_BASE } = process.env;
if (!CONVEX_URL || !key || !token) {
  console.error("Set CONVEX_URL, DASHBOARD_KEY and RUNNER_TOKEN (see the top of this file).");
  process.exit(2);
}
const os = { darwin: "macos", linux: "linux", win32: "windows" }[process.platform as string] ?? process.platform;
const outDir = resolve("artifacts", "multi-platform", os);
mkdirSync(outDir, { recursive: true });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const convex = new ConvexHttpClient(CONVEX_URL);

// Paths as awkward as a real machine's: a space and non-ASCII in each.
const scratch = mkdtempSync(join(tmpdir(), "perry-e2e-"));
const perryHome = join(scratch, "perry home ü");
const workdir = join(scratch, "work space ü");
// Outside every writable root. Not in the temp folder, which workspace-write may write.
const outside = join(homedir(), `.perry-e2e-outside-${Date.now()}`);
for (const dir of [perryHome, workdir, outside]) mkdirSync(dir, { recursive: true });
const name = `e2e-${os}-${hostname()}`.slice(0, 60);

const codex = (args: string[]) => {
  const ran = process.platform === "win32"
    ? spawnSync(process.env.COMSPEC || "cmd.exe", ["/d", "/s", "/c", ["codex", ...args].join(" ")], { encoding: "utf8" })
    : spawnSync("codex", args, { encoding: "utf8" });
  return { code: ran.status, output: `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim() };
};

// The runner, as a service would run it: no terminal, no --auto.
const logFile = join(outDir, "runner.log");
writeFileSync(logFile, "");
const runner = spawn(process.execPath, [resolve("runner", "index.ts"), "--url", CONVEX_URL, "--token", token, "--dir", workdir, "--name", name, "--no-auto"], {
  env: { ...process.env, PERRY_HOME: perryHome },
  stdio: ["ignore", "pipe", "pipe"],
});
const log = () => readFileSync(logFile, "utf8").replace(/\x1b\[[0-9;]*m/g, "");
runner.stdout.on("data", (d) => writeFileSync(logFile, d, { flag: "a" }));
runner.stderr.on("data", (d) => writeFileSync(logFile, d, { flag: "a" }));

async function waitFor<T>(what: string, timeoutMs: number, probe: () => Promise<T | null | undefined | false> | T | null | undefined | false): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await probe();
    if (value) return value;
    await sleep(1000);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const checkIn = () => convex.mutation(api.runner.checkIn, { token, platform: process.platform, hostname: hostname(), workdir, autoApprove: false });

type Message = { id: string; role: string; text: string; attachments: Array<{ url: string; fileName: string; contentType: string }> };
async function messages(chat: Id<"conversations">): Promise<Message[]> {
  const page = await convex.query(api.dashboard.getChatMessages, { key: key!, id: chat, paginationOpts: { numItems: 30, cursor: null } });
  return [...page.page].reverse() as Message[];
}

/** Send one message and wait for its reply, answering approvals from this runner as they come. */
async function turn(chat: Id<"conversations">, text: string, answer?: "approve" | "decline") {
  const before = (await messages(chat)).filter((m) => m.role === "assistant").length;
  await checkIn();
  // Keep this runner the freshest until the chat is bound to it.
  const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
  await convex.mutation(api.dashboard.sendChat, { key: key!, id: chat, text });
  const asked: Array<{ kind: string; title: string; runner: string; answered: string }> = [];
  try {
    return await waitFor("a reply", 8 * 60_000, async () => {
      for (const request of await convex.query(api.approvals.pending, { key: key! })) {
        if (request.chat?.id !== chat || request.runner !== name) continue;
        const approved = answer === "approve";
        await convex.mutation(api.approvals.decide, { key: key!, id: request.id, approved });
        asked.push({ kind: request.kind, title: request.title, runner: request.runner, answered: approved ? "approved" : "declined" });
      }
      const state = await convex.query(api.dashboard.getChat, { key: key!, id: chat });
      if (state.isRunning) return null;
      const replies = (await messages(chat)).filter((m) => m.role === "assistant");
      if (replies.length > before) return { reply: replies.at(-1)!, asked, error: null as string | null };
      if (state.lastError) return { reply: null, asked, error: state.lastError };
      return null;
    });
  } finally {
    clearInterval(heartbeat);
  }
}

const result: Record<string, unknown> = { ranAt: new Date().toISOString(), os, platform: process.platform, release: release(), runnerName: name, workdir, outside };
let pass = false;
try {
  result.codex = { version: codex(["--version"]).output, login: codex(["login", "status"]).output };
  await waitFor("the runner to connect", 90_000, () => log().includes("connected.") || runner.exitCode !== null);
  if (runner.exitCode !== null) throw new Error(`the runner exited (${runner.exitCode}): ${log()}`);

  const chat = await convex.mutation(api.dashboard.createChat, { key });
  result.chatId = chat;

  const note = "e2e ü note.txt";
  const shared = "shared ü.txt";
  const work = await turn(chat, [
    "This is an automated end-to-end test of this machine. Do each step, then reply in four short lines.",
    "1) Name the operating system and the shell you were told your commands run in on this machine.",
    "2) Run a shell command that prints this OS's name (uname -s where there is one; on Windows, [System.Environment]::OSVersion.VersionString) and quote its output.",
    `3) Create a file named "${note}" in your workspace, containing exactly the word perry-e2e.`,
    `4) Save a file named "${shared}" containing exactly the word shared-e2e in your own files folder, and show it in the chat with share_file.`,
  ].join("\n"));
  const runs = await convex.query(api.dashboard.listRuns, { key, conversationId: chat });
  const spans = runs[0] ? await convex.query(api.dashboard.runTrace, { key, runId: runs[0].id as Id<"runs"> }) : [];
  const attachment = work.reply?.attachments.find((file) => file.fileName === shared);
  let served: { status: number; body: string } | null = null;
  if (attachment && MEDIA_BASE) {
    const response = await fetch(new URL(attachment.url, MEDIA_BASE), { headers: { cookie: `perry_media=${encodeURIComponent(key)}` } });
    served = { status: response.status, body: (await response.text()).trim() };
  }
  const osWord = { macos: /mac ?os|darwin/i, linux: /linux/i, windows: /windows/i }[os] ?? /./;
  const notePath = join(workdir, note);
  result.work = {
    reply: work.reply?.text ?? null,
    error: work.error,
    askedForApproval: work.asked,
    spans: spans.map((span) => ({ kind: span.kind, name: span.name, status: span.status, output: span.output?.slice(0, 300) })),
    file: existsSync(notePath) ? readFileSync(notePath, "utf8").trim() : null,
    shared: attachment ?? null,
    served,
  };
  const workChecks = {
    replied: Boolean(work.reply?.text),
    namesThisOs: osWord.test(work.reply?.text ?? ""),
    commandRan: spans.some((span) => span.kind === "command" && span.status === "ok"),
    fileMade: existsSync(notePath) && readFileSync(notePath, "utf8").trim() === "perry-e2e",
    fileShared: Boolean(attachment?.url.startsWith("/api/media/")),
    mediaServed: MEDIA_BASE ? served?.status === 200 && served.body === "shared-e2e" : "skipped (no MEDIA_BASE)",
  };

  const approvedFile = join(outside, "approved.txt");
  const declinedFile = join(outside, "declined.txt");
  const ask = (file: string, word: string) =>
    `This is an automated test of approvals. Use your shell to write the word ${word} into the file ${file}. That path is outside your workspace, so request approval to write it; do not write anywhere else. Then reply in one short sentence saying whether it worked.`;
  const approved = await turn(chat, ask(approvedFile, "approved-e2e"), "approve");
  const declined = await turn(chat, ask(declinedFile, "declined-e2e"), "decline");
  await sleep(1500);
  const runnerLog = log();
  result.approvals = {
    approved: { asked: approved.asked, reply: approved.reply?.text ?? null, error: approved.error, file: existsSync(approvedFile) ? readFileSync(approvedFile, "utf8").trim() : null },
    declined: { asked: declined.asked, reply: declined.reply?.text ?? null, error: declined.error, file: existsSync(declinedFile) ? readFileSync(declinedFile, "utf8").trim() : null },
  };
  const approvalChecks = {
    askedInDashboard: approved.asked.length > 0 && declined.asked.length > 0,
    approvedRan: existsSync(approvedFile) && readFileSync(approvedFile, "utf8").trim() === "approved-e2e",
    declinedDidNot: !existsSync(declinedFile),
    runnerHeardBoth: runnerLog.includes("approved in the dashboard") && runnerLog.includes("declined in the dashboard"),
    noTerminalPrompt: runnerLog.includes("approve or decline it in the dashboard"),
  };

  result.checks = { runner: { connected: true, turnsRanHere: runnerLog.includes("saved Codex turn") }, work: workChecks, approvals: approvalChecks };
  pass = Object.values({ turnsRanHere: runnerLog.includes("saved Codex turn"), ...workChecks, ...approvalChecks }).every((value) => value === true || (typeof value === "string" && value.startsWith("skipped")));
} catch (error) {
  result.error = (error as Error).message;
} finally {
  runner.kill();
  await sleep(1000);
  rmSync(outside, { recursive: true, force: true });
  rmSync(scratch, { recursive: true, force: true });
}
result.pass = pass;
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
process.exit(pass ? 0 : 1);
