import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { FAKE_AGENT, perry, sleep } from "../engine-acp/harness";

// bun artifacts/live-work/run.ts <outDir>
// The fold over a turn's work, live (issue #272): "Working for 12s · 3 steps"
// from the moment the turn starts, open to its steps as they come, and the
// same fold, now "Worked for 46s · 3 steps", above the reply after, left as
// the owner set it.
//
// No model runs: the engine is the fake ACP agent playing Grok Build
// (artifacts/engine-acp/fake-agent.ts: STEPS for timed steps, RUN for a command
// that asks first). Everything else is real: a fresh Perry from the production
// build (`pnpm build` first) on a spare port, its own PERRY_HOME, the real
// runner, and the chat in headless Chrome.
//
// A step is one thing the engine did that it reported as a tool call: a command,
// a file edit, a search, one of Perry's tools. Its thinking is not a step.
//
// Ways it could fail, written down before the checks:
//   1. No fold until the turn ends: none while it thinks before its first step,
//      or none while a step runs.
//   2. The fold is frozen: its time or its count of steps does not move without
//      a reload, or it counts a step twice.
//   3. It cannot be opened or closed while the turn runs, or has no expanded
//      state for a screen reader.
//   4. When the turn ends the fold is drawn twice (live and above the reply at
//      once), or forgets that the owner opened it.
//   5. It says "Worked for" while the turn still runs, or "Working" after.
//   6. Waiting on the owner's approval reads as working (a spinner, "Working",
//      "Thinking"), or the steps go while it waits.
//   7. Stopped mid-step, a step left open spins on, or reads as done.
//   8. After a reload mid-turn, the fold is gone, says it is done, or shows the
//      steps twice; after a reload at the end, a spinner is left.
//   9. On a phone's width it does not fit, or the page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/live-work/run.ts <outDir>");
let fakeHome = "";
const p = await perry({
  name: "live-work",
  outDir,
  runnerEnv: (home) => {
    fakeHome = join(home, "fake-grok");
    mkdirSync(fakeHome, { recursive: true });
    writeFileSync(join(fakeHome, "grok-signed-in"), "yes");
    writeFileSync(join(fakeHome, "steps-secret"), "live-work-not-a-secret");
    mkdirSync(join(home, "no-codex"), { recursive: true });
    mkdirSync(join(home, "no-claude"), { recursive: true });
    return { PERRY_GROK_COMMAND: `${process.execPath} ${FAKE_AGENT} --profile grok`, FAKE_ACP_HOME: fakeHome, CODEX_HOME: join(home, "no-codex"), CLAUDE_CONFIG_DIR: join(home, "no-claude") };
  },
});
const { KEY, BASE, call, check, notes, until, getChat } = p;

const site = createServer((_request, response) => {
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.end(`<!doctype html><title>Live work test page</title><body><h1>Live work</h1></body>`);
});
const sitePort = await new Promise<number>((done) => site.listen(0, "127.0.0.1", () => done((site.address() as { port: number }).port)));
const PAGE = `http://127.0.0.1:${sitePort}/`;
const workDir = join(p.home, "work");
mkdirSync(workDir, { recursive: true });
const steps = (gap: number) => `STEPS ${JSON.stringify({ dir: workDir, page: PAGE, secretPage: PAGE, gap })}`;

type Browser = NonNullable<ReturnType<typeof p.browser>>;
type Fold = { run: string; state: string; label: string; expanded: string | null; steps: number; spinning: number; live: boolean; thinking: boolean };
let ok = false;
try {
  p.start("server");
  await until(() => fetch(`${BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await call<Array<{ online: boolean; engines: Array<{ kind: string; signedIn: boolean }> }>>("engines:list", { key: KEY }))
    .some((item) => item.online && item.engines.some((engine) => engine.kind === "grok" && engine.signedIn)), "the runner with Grok signed in", 120);
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });
  const chat = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: chat, model: "grok-fake-fast", engine: "grok" });

  const b = await p.openBrowser() as Browser;
  const { evaluate, send } = b;
  const waitFor = (test: string, what: string, seconds = 30) => until(() => evaluate(`Boolean(${test})`), what, seconds);
  const shot = async (name: string) => {
    await sleep(250);
    const image = await send("Page.captureScreenshot", { format: "png" }) as { data: string };
    writeFileSync(join(outDir, name), Buffer.from(image.data, "base64"));
  };
  // Every fold on the page, live or above a reply.
  const folds = () => evaluate(`[...document.querySelectorAll("[data-work]")].map((fold) => {
    const live = Boolean(fold.closest("[data-thinking], [data-streaming]"));
    const toggle = fold.querySelector(":scope > button");
    return { run: fold.dataset.run, state: fold.dataset.workState, label: (toggle ?? fold).textContent.trim(), expanded: toggle?.getAttribute("aria-expanded") ?? null,
      steps: fold.querySelectorAll("[data-step]").length, spinning: fold.querySelectorAll('[data-step][data-status="running"]').length, live,
      thinking: Boolean(document.querySelector('[data-thinking] > p[data-step="Thinking"]')) };
  })`) as Promise<Fold[]>;
  const liveFold = async () => (await folds()).find((fold) => fold.live);
  const toggleLive = () => evaluate(`document.querySelector("[data-thinking] [data-work] > button, [data-streaming] [data-work] > button").click(); true`);
  const serverSteps = async (chatId: string) => {
    const runs = await call<Array<{ status: string; steps: unknown[] }>>("dashboard:getChatWork", { key: KEY, id: chatId });
    return runs.at(-1)?.steps.length ?? 0;
  };
  await send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
  await waitFor(`document.querySelector("#composer")`, "the chat to open");

  // --- 1-5. A turn of steps, watched from its start to its reply --------------------------------------------
  const seen: Array<Fold[] & { at?: number }> = [];
  let watching = true;
  const watch = (async () => {
    while (watching) {
      const now = await folds().catch(() => null);
      if (now) seen.push(Object.assign(now, { at: Date.now() }));
      await sleep(100);
    }
  })();
  await call("dashboard:sendChat", { key: KEY, id: chat, text: steps(1500) });
  await until(async () => Boolean(await liveFold()), "the live fold", 60);
  const first = (await liveFold())!;
  notes.firstLiveFold = first;
  check("foldBeforeTheFirstStepEnds", /^Working for /.test(first.label) && first.state === "working" && (await serverSteps(chat)) <= 1);
  check("openWhileLive", first.expanded === null || first.expanded === "true");
  await waitFor(`document.querySelector('[data-thinking] [data-work] [data-step][data-status="running"], [data-streaming] [data-work] [data-step][data-status="running"]')`, "a step running in the fold", 60);
  await shot("live-open-light.png");
  // The owner closes it and opens it again while it runs: the fold answers each time, and keeps "open" through the end.
  await toggleLive();
  await sleep(300);
  const closed = (await liveFold())!;
  await toggleLive();
  await sleep(300);
  const reopened = (await liveFold())!;
  check("togglesWhileLive", closed.expanded === "false" && closed.steps === 0 && reopened.expanded === "true" && reopened.steps > 0, { closed, reopened });
  await until(async () => !(await getChat(chat)).isRunning, "the reply to finish", 120);
  await waitFor(`!document.querySelector("[data-thinking], [data-streaming]") && document.querySelector('[data-role="assistant"] [data-work]')`, "the reply to land", 30);
  await sleep(1_500);
  watching = false;
  await watch;

  const liveSamples = seen.map((sample) => sample.find((fold) => fold.live)).filter((fold): fold is Fold => Boolean(fold && fold.state === "working"));
  const counts = liveSamples.map((fold) => Number(/· (\d+) steps?/.exec(fold.label)?.[1] ?? 0));
  const seconds = liveSamples.map((fold) => /Working for (?:(\d+)m )?(\d+)s/.exec(fold.label)).filter(Boolean).map((m) => Number(m![1] ?? 0) * 60 + Number(m![2]));
  notes.liveCounts = [...new Set(counts)];
  check("countGrowsLive", counts.length > 5 && counts.every((count, index) => index === 0 || count >= counts[index - 1]!) && new Set(counts).size >= 4);
  check("timeRunsLive", seconds.length > 5 && seconds.at(-1)! - seconds[0]! >= 5);
  const doubled = seen.filter((sample) => new Set(sample.map((fold) => fold.run)).size !== sample.length);
  check("neverTwoFoldsForATurn", doubled.length === 0, doubled.slice(0, 2));
  check("noWorkedForWhileLive", seen.every((sample) => sample.every((fold) => !fold.live || fold.state !== "working" || /^Working for /.test(fold.label))));
  const after = (await folds()).at(-1)!;
  notes.afterFold = after;
  const finalCount = await serverSteps(chat);
  check("sameFoldAfter", after.run === first.run && /^Worked for (<1s|\d+s|\d+m \d+s) · \d+ steps$/.test(after.label) && after.label.endsWith(`· ${finalCount} steps`));
  check("keptOpenAfter", after.expanded === "true" && after.steps === finalCount && after.spinning === 0);
  await shot("after-open-light.png");

  // The next turn, left alone: open while it runs, quiet (closed) once its reply lands.
  await call("dashboard:sendChat", { key: KEY, id: chat, text: steps(300) });
  await until(async () => Boolean(await liveFold()), "the second turn's fold", 60);
  await until(async () => !(await getChat(chat)).isRunning, "the second reply", 120);
  await waitFor(`!document.querySelector("[data-thinking], [data-streaming]")`, "the second reply to land", 30);
  await sleep(1_000);
  const second = (await folds()).at(-1)!;
  check("untouchedFoldsCloseAfter", second.run !== first.run && second.expanded === "false" && /^Worked for /.test(second.label), second);

  // --- 6. Waiting on an approval is not working ---------------------------------------------------------------
  await call("dashboard:setDefaultAccess", { key: KEY, access: "supervised" });
  const asking = await call<string>("dashboard:createChat", { key: KEY });
  await call("dashboard:setChatModel", { key: KEY, id: asking, model: "grok-fake-fast", engine: "grok" });
  await send("Page.navigate", { url: `${BASE}/chat/${asking}` });
  await waitFor(`document.querySelector("#composer")`, "the second chat to open");
  await call("dashboard:sendChat", { key: KEY, id: asking, text: "RUN echo live-work" });
  const pending = () => call<Array<{ id: string; chat?: { id: string } }>>("approvals:pending", { key: KEY }).then((rows) => rows.filter((row) => row.chat?.id === asking));
  await until(async () => (await pending()).length > 0, "the approval", 60);
  await waitFor(`document.querySelector('[data-work][data-work-state="waiting"]')`, "the fold to say it waits", 20).catch(() => {});
  await sleep(500);
  const waiting = await liveFold();
  notes.waitingFold = waiting;
  const held = await evaluate(`[...document.querySelectorAll('[data-work][data-work-state="waiting"] [data-step]')].map((step) => step.dataset.status)`) as string[];
  notes.heldSteps = held;
  check("approvalIsWaitingNotWorking", Boolean(waiting && waiting.state === "waiting" && /^Waiting for your approval/.test(waiting.label) && !waiting.thinking && waiting.spinning === 0
    && held.includes("waiting") && !(await evaluate(`Boolean(document.querySelector('[data-work][data-work-state="waiting"] .motion-safe\\\\:animate-spin'))`))));
  check("approvalCardShown", await evaluate(`document.body.innerText.includes("echo live-work")`) as boolean);
  await shot("waiting-light.png");
  await call("approvals:decide", { key: KEY, id: (await pending())[0]!.id, approved: true });
  await until(async () => !(await getChat(asking)).isRunning, "the approved reply", 60);
  await waitFor(`!document.querySelector("[data-thinking], [data-streaming]") && document.querySelector('[data-role="assistant"] [data-work]')`, "the approved reply to land", 30);
  check("approvedSettlesDone", /^Worked for /.test((await folds()).at(-1)?.label ?? ""), (await folds()).at(-1));
  await call("dashboard:setDefaultAccess", { key: KEY, access: "full" });

  // --- 8. A reload mid-turn finds the turn where it is -------------------------------------------------------
  await send("Page.navigate", { url: `${BASE}/chat/${chat}` });
  await waitFor(`document.querySelector("#composer")`, "the first chat again");
  await call("dashboard:sendChat", { key: KEY, id: chat, text: steps(1500) });
  await waitFor(`document.querySelector('[data-thinking] [data-work] [data-step][data-status="running"], [data-streaming] [data-work] [data-step][data-status="running"]')`, "a step running before the reload", 60);
  await sleep(2_000);
  await send("Page.reload", {});
  await waitFor(`document.querySelector("[data-thinking] [data-work], [data-streaming] [data-work]")`, "the live fold after the reload", 30);
  await sleep(500);
  const reloaded = (await liveFold())!;
  const onServer = await serverSteps(chat);
  const runsShown = await evaluate(`[...document.querySelectorAll("[data-work]")].map((fold) => fold.dataset.run)`) as string[];
  check("reloadFindsItLive", reloaded.state === "working" && /^Working for /.test(reloaded.label) && Math.abs(reloaded.steps - onServer) <= 1 && new Set(runsShown).size === runsShown.length, { reloaded, onServer });
  await until(async () => !(await getChat(chat)).isRunning, "the reloaded turn to finish", 120);
  await waitFor(`!document.querySelector("[data-thinking], [data-streaming]")`, "the reloaded turn to land", 30);

  // --- 7. Stopped mid-step ------------------------------------------------------------------------------------
  await call("dashboard:sendChat", { key: KEY, id: chat, text: steps(3000) });
  await waitFor(`document.querySelector('[data-thinking] [data-work] [data-step][data-status="running"], [data-streaming] [data-work] [data-step][data-status="running"]')`, "a step running to stop", 60);
  await call("dashboard:stopChat", { key: KEY, id: chat });
  await until(async () => !(await getChat(chat)).isRunning, "the stop", 60);
  await waitFor(`!document.querySelector("[data-thinking], [data-streaming]")`, "the stopped turn to settle", 30);
  await sleep(1_500);
  const stopped = await evaluate(`(() => {
    const fold = [...document.querySelectorAll("[data-work]")].at(-1);
    const toggle = fold.querySelector(":scope > button");
    if (toggle.getAttribute("aria-expanded") !== "true") toggle.click();
    return true;
  })()`).then(() => sleep(300)).then(() => folds()).then((all) => all.at(-1)!);
  const stoppedSteps = await evaluate(`[...[...document.querySelectorAll("[data-work]")].at(-1).querySelectorAll("[data-step]")].map((step) => step.dataset.status)`) as string[];
  notes.stopped = { stopped, stoppedSteps };
  check("stoppedSettles", stopped.state !== "working" && !/^Working/.test(stopped.label) && stopped.spinning === 0 && !(await evaluate(`Boolean(document.querySelector(".motion-safe\\\\:animate-spin"))`)));
  await send("Page.reload", {});
  await waitFor(`document.querySelector('[data-role="assistant"] [data-work]')`, "the chat after the stop and a reload", 30);
  await sleep(1_000);
  check("noSpinnerAfterReload", !(await evaluate(`Boolean(document.querySelector("[data-thinking], [data-streaming], .motion-safe\\\\:animate-spin"))`)));

  // --- 9. A phone's width, in dark ---------------------------------------------------------------------------
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await call("dashboard:sendChat", { key: KEY, id: chat, text: steps(1200) });
  await waitFor(`document.querySelector('[data-thinking] [data-work] [data-step], [data-streaming] [data-work] [data-step]')`, "the live fold on a phone", 60);
  const fits = await evaluate(`(() => { const fold = document.querySelector("[data-thinking] [data-work], [data-streaming] [data-work]"); return fold.getBoundingClientRect().right <= innerWidth && document.documentElement.scrollWidth <= innerWidth; })()`) as boolean;
  check("fitsOnAPhone", fits);
  await shot("live-phone-dark.png");
  await until(async () => !(await getChat(chat)).isRunning, "the phone turn to finish", 120);
  check("noPageErrors", b.errors.length === 0, b.errors);
  ok = true;
} catch (error) {
  notes.stoppedAt = String(error);
  check("completed", false);
} finally {
  site.close();
}
const passed = await p.finish({ ok });
process.exit(passed ? 0 : 1);
