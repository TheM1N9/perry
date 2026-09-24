import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ConvexHttpClient } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { openChat, sleep } from "../browser";

// bun artifacts/traces/run.ts <outDir> <dashboardKey> <runnerToken>
// Needs `next dev -p 3005`, a runner on this branch, CONVEX_URL and E2E_WORKDIR
// (the runner's working directory).
//
// A web chat asks Perry to create a small file and then list the working
// directory with a shell command. The run must come back with a trace of both.
//
// Ways this can fail, and what catches each:
//  1. The runner never hears item/started or item/completed for the turn (wrong
//     thread or turn match, events dropped before turn/start answers): no
//     command or file change span.                        -> both spans exist
//  2. traceTurn is refused, or its last report lands after finishTurn: spans
//     missing, or stuck as running.                       -> no span is running
//  3. A start and its completion are not merged by item id: the same item twice.
//                                                          -> callIds are unique
//  4. Timing is wrong: no duration, a negative one, or a start far outside the
//     run.                                                -> durations >= 0 and
//     starts within the run, allowing a minute of clock skew between machines
//  5. Status is wrong: a command that worked marked failed, or a file change
//     with no path or kind.            -> command ok, its output tail names the
//     file; file change ok, named by the file, input says "add"
//  6. Token usage is lost (listener mismatch, or the duplicate filter dropping
//     every update) or mangled.   -> input and output > 0, cached <= input,
//     reasoning <= output, total >= input + output, steps >= 1. (Double
//     counting a repeated update cannot be told apart from a real response here.)
//  7. The run's tool calls are not filled from the trace.  -> shell and apply_patch
//  8. Input or output is not cut to size.                  -> every field <= 2048
//  9. The Activity page does not render the trace: no bars, no tokens line, or
//     a page error.   -> Trace opens, bars have width, the tokens line shows,
//     a span's input and output open, screenshot, no page errors
// 10. Deleting the chat leaves the spans behind.  -> the run's trace is empty after

const [, , outDir, dashboardKey, runnerToken] = process.argv;
const base = "http://localhost:3005";
mkdirSync(outDir, { recursive: true });
const convex = new ConvexHttpClient(process.env.CONVEX_URL!);
const checkIn = () => convex.mutation(api.runner.checkIn, { token: runnerToken, platform: "win32", hostname: "e2e", workdir: process.env.E2E_WORKDIR, autoApprove: true });
const { evaluate, send, errors, close } = await openChat(base, dashboardKey);
const fileName = `perry-trace-${Date.now()}.txt`;

// 1. One turn that edits a file and runs a command.
await evaluate(`document.querySelector('.chat-header-new').click(); true`);
await evaluate(`(() => {
  const box = document.querySelector('.chat-composer-box textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, ${JSON.stringify(
    `This is an automated end-to-end test. In your working directory: first create a file named ${fileName} containing the single word traced, using your file editing tool (apply_patch), not a shell command. Then run one shell command that lists the files in the working directory. Then reply with the single word DONE.`,
  )});
  box.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);
await checkIn();
const heartbeat = setInterval(() => void checkIn().catch(() => {}), 1000);
await evaluate(`document.querySelector('.chat-send').click(); true`);
const answer = await evaluate(`new Promise((resolve, reject) => {
  const start = Date.now();
  const tick = () => {
    const replies = [...document.querySelectorAll('.chat-turn.from-assistant:not(.pending) .chat-bubble')];
    const error = document.querySelector('.chat-turn-error');
    const thinking = document.querySelector('.chat-thinking');
    if (!thinking && replies.length > 0) return resolve({ reply: replies.at(-1).innerText, error: null });
    if (!thinking && error && Date.now() - start > 5000) return resolve({ reply: null, error: error.innerText });
    if (Date.now() - start > 300000) return reject(new Error('no reply within 5 minutes'));
    setTimeout(tick, 1000);
  };
  setTimeout(tick, 3000);
})`);
clearInterval(heartbeat);
const chatId = await evaluate(`decodeURIComponent(location.pathname.split('/')[2] ?? '')`) as Id<"conversations">;

// 2. The run and its trace, as Convex has them. The run finishes a moment after the reply shows.
const finished = async () => {
  for (let i = 0; i < 30; i += 1) {
    const run = (await convex.query(api.dashboard.listRuns, { key: dashboardKey, conversationId: chatId }))[0];
    if (run && run.status !== "running") return run;
    await sleep(1000);
  }
  throw new Error("the run never finished");
};
const run = await finished();
const spans = await convex.query(api.dashboard.runTrace, { key: dashboardKey, runId: run.id as Id<"runs"> });
const command = spans.find((span) => span.kind === "command");
const fileChange = spans.find((span) => span.kind === "fileChange" && span.name.includes(fileName));
const runEnd = run.startedAt + (run.durationMs ?? 0);
const SKEW = 60_000;
const timed = spans.every((span) => typeof span.durationMs === "number" && span.durationMs >= 0
  && span.startedAt >= run.startedAt - SKEW && span.startedAt + span.durationMs <= runEnd + SKEW);
const sized = spans.every((span) => (span.input?.length ?? 0) <= 2048 && (span.output?.length ?? 0) <= 2048 && span.name.length <= 300);
const usage = run.usage;
const usageOk = Boolean(usage && (usage.inputTokens ?? 0) > 0 && (usage.outputTokens ?? 0) > 0
  && (usage.cachedInputTokens ?? 0) <= (usage.inputTokens ?? 0)
  && (usage.reasoningTokens ?? 0) <= (usage.outputTokens ?? 0)
  && (usage.totalTokens ?? 0) >= (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0))
  && (run.steps ?? 0) >= 1;

// 3. The Activity page, filtered to this chat, with the run's trace open.
await evaluate(`[...document.querySelectorAll('.chat-nav-grid a')].find((link) => link.textContent.includes('Activity')).click(); true`);
await evaluate(`new Promise((resolve, reject) => { const start = Date.now(); const tick = () => document.querySelector('.activity-run') ? resolve(true) : Date.now() - start > 30000 ? reject(new Error('Activity never rendered')) : setTimeout(tick, 200); tick(); })`);
await evaluate(`(() => {
  const select = [...document.querySelectorAll('.activity-filters select')][0];
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(select, ${JSON.stringify(chatId)});
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);
await sleep(1500);
const page = await evaluate(`new Promise((resolve, reject) => {
  const runs = document.querySelectorAll('.activity-run');
  const first = runs[0];
  if (!first) return reject(new Error('no run listed for this chat'));
  first.querySelector('.activity-trace summary').click();
  const start = Date.now();
  const tick = () => {
    const rows = [...first.querySelectorAll('.trace-span')];
    if (rows.length < 2) return Date.now() - start > 20000 ? reject(new Error('the trace never rendered')) : setTimeout(tick, 200);
    const shell = rows.find((row) => row.querySelector('.trace-label em')?.textContent === 'shell');
    shell?.querySelector('.trace-io summary')?.click();
    first.scrollIntoView({ block: 'start' });
    resolve({
      runsListed: runs.length,
      // Inside the collapsed Details, so its text is read, not its rendering.
      tokens: first.querySelector('.activity-tokens')?.textContent ?? null,
      rows: rows.map((row) => ({
        status: row.className.replace('trace-span', '').trim(),
        label: row.querySelector('.trace-label')?.innerText,
        barWidth: row.querySelector('.trace-bar')?.getBoundingClientRect().width ?? 0,
        time: row.querySelector('.trace-time')?.innerText,
      })),
      shellDetails: shell?.querySelector('.trace-io')?.innerText ?? null,
    });
  };
  tick();
})`);
await sleep(500);
const shot = await send("Page.captureScreenshot", { format: "png" });
writeFileSync(join(outDir, "activity-trace.png"), Buffer.from(shot.data, "base64"));

// 4. Clean up: the chat, and with it the run and its spans, and the file.
await convex.mutation(api.dashboard.deleteChat, { key: dashboardKey, id: chatId });
const afterDelete = await convex.query(api.dashboard.runTrace, { key: dashboardKey, runId: run.id as Id<"runs"> });
const filePath = process.env.E2E_WORKDIR ? join(process.env.E2E_WORKDIR, fileName) : null;
const fileMade = Boolean(filePath && existsSync(filePath));
if (filePath && fileMade) rmSync(filePath);

const pass = Boolean(answer.reply) && run.status === "ok"
  && command?.status === "ok" && Boolean(command.output?.includes(fileName))
  && fileChange?.status === "ok" && /\badd\b/.test(fileChange.input ?? "")
  && !spans.some((span) => span.status === "running")
  && new Set(spans.map((span) => span.id)).size === spans.length
  && timed && sized && usageOk
  && Boolean(run.toolCalls?.includes("shell")) && Boolean(run.toolCalls?.includes("apply_patch"))
  && /in .* cached .* out/.test(page.tokens ?? "") && page.rows.length === spans.length
  && page.rows.every((row: { barWidth: number }) => row.barWidth > 0) && Boolean(page.shellDetails?.includes(fileName))
  && fileMade && afterDelete.length === 0 && errors.length === 0;
const result = {
  ranAt: new Date().toISOString(),
  chatId,
  fileName,
  answer,
  run: { id: run.id, status: run.status, steps: run.steps, toolCalls: run.toolCalls, usage, durationMs: run.durationMs },
  spans: spans.map((span) => ({
    kind: span.kind, name: span.name.slice(0, 120), status: span.status,
    offsetMs: span.startedAt - run.startedAt, durationMs: span.durationMs,
    input: span.input?.slice(0, 200), output: span.output?.slice(-200),
  })),
  checks: { command: Boolean(command), fileChange: Boolean(fileChange), timed, sized, usageOk, fileMade },
  page,
  spansAfterDelete: afterDelete.length,
  pageErrors: errors,
  pass,
};
writeFileSync(join(outDir, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify(result, null, 2));
close();
process.exit(pass ? 0 : 1);
