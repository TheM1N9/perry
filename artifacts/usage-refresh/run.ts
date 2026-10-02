import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { perry, REPO, sleep } from "../engine-acp/harness";

// bun artifacts/usage-refresh/run.ts <outDir>
// The Usage page's refresh button: one click and every signed-in engine's
// plan limits are read again now, instead of at the runner's next five
// minutes. A fresh production Perry (`pnpm build` first) on a spare port with
// its own PERRY_HOME (PERRY_E2E_DIR, else the temp folder), the real runner,
// and headless Chrome. Codex is the stand-in from artifacts/choose-engine
// (fake-cli.ts), signed in, its plan's windows read from a file this check
// writes; Claude Code and Grok are taken off the PATH and pointed at nothing,
// so nothing reaches the owner's own accounts.
//
// Ways it could fail, written down before the checks:
//   1. There is no refresh button on the Usage page, or it has no label.
//   2. Clicking it reads nothing: the limits stay as they were until the
//      runner's five-minute read.
//   3. It reads, but the page does not show the new numbers without a reload.
//   4. The button never stops spinning, or spins when nothing was asked.
//   5. Clicked again and again, it reads the plan every time (it should take
//      one read for clicks close together).
//   6. The owner's real Codex, Claude or Grok is reached.
//   7. The page throws.

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/usage-refresh/run.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const WINDOWS = process.platform === "win32";
const FAKE_CLI = join(REPO, "artifacts", "choose-engine", "fake-cli.ts");
const PATH_KEY = Object.keys(process.env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
const ENGINE_CLIS = ["codex", "claude", "grok"];
/** This machine's PATH without any folder that holds a real codex, claude or grok. */
const cleanPath = (process.env[PATH_KEY] ?? "").split(delimiter).filter((dir) => dir && !ENGINE_CLIS.some((name) =>
  ["", ".cmd", ".exe", ".bat", ".ps1"].some((ext) => existsSync(join(dir, name + ext))))).join(delimiter);

let state = "";
const limits = (fiveHour: number, weekly: number) => writeFileSync(join(state, "codex-limits.json"), JSON.stringify({
  limitId: "codex", planType: "plus",
  primary: { usedPercent: fiveHour, windowDurationMins: 300, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 },
  secondary: { usedPercent: weekly, windowDurationMins: 10080, resetsAt: Math.floor(Date.now() / 1000) + 4 * 86400 },
}));
const reads = () => existsSync(join(state, "log.jsonl"))
  ? readFileSync(join(state, "log.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => entry.method === "account/rateLimits/read").length
  : 0;

const p = await perry({
  name: "usage-refresh",
  outDir,
  engine: "codex",
  runnerEnv: (home) => {
    state = join(home, "fake-cli");
    const bin = join(home, "bin");
    mkdirSync(state, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(state, "codex-signed-in"), "yes");
    limits(20, 40);
    const command = [process.execPath, FAKE_CLI, "codex"];
    if (WINDOWS) writeFileSync(join(bin, "codex.cmd"), `@${command.map((word) => `"${word}"`).join(" ")} %*\r\n`);
    else { writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec ${command.map((word) => `"${word}"`).join(" ")} "$@"\n`); chmodSync(join(bin, "codex"), 0o755); }
    return {
      [PATH_KEY]: `${bin}${delimiter}${cleanPath}`,
      FAKE_CLI_HOME: state,
      CODEX_HOME: join(home, "codex"),
      CLAUDE_CONFIG_DIR: join(home, "claude"),
      PERRY_GROK_COMMAND: join(home, "no-grok-here"),
    };
  },
});
const { check, call, until, KEY } = p;

type Overview = { engines: Array<{ kind: string; usage?: { limits?: { windows: Array<{ label: string; usedPercent: number }> } } }>; readAt?: number; refreshAt?: number };
const overview = () => call<Overview>("usage:overview", { key: KEY });
const codexPercents = async () => (await overview()).engines.find((engine) => engine.kind === "codex")?.usage?.limits?.windows.map((window) => window.usedPercent) ?? [];

try {
  p.start("server");
  await until(() => fetch(`${p.BASE}/api/backend/http/health`).then((r) => r.ok, () => false), "the server to start", 90);
  await call("dashboard:skipOnboarding", { key: KEY }).catch(() => {});
  p.start("runner");
  await until(async () => (await p.computers()).some((computer) => computer.online && computer.engines.some((engine) => engine.kind === "codex" && engine.signedIn)), "the stand-in Codex signed in", 120);
  // The real CLIs are off the PATH: the one Codex that answers is the stand-in, which logs every start.
  await until(async () => JSON.stringify(await codexPercents()) === "[20,40]", "the first read of the plan", 90);
  const atStart = reads();
  check("standInOnly", atStart >= 1 && existsSync(join(state, "log.jsonl")), { reads: atStart });

  // The plan moves on; the runner would not read it again for five minutes.
  limits(63, 71);
  await sleep(3_000);
  check("notReadWithoutAsking", JSON.stringify(await codexPercents()) === "[20,40]" && reads() === atStart, { percents: await codexPercents(), reads: reads() });

  await p.openBrowser();
  const browser = p.browser()!;
  await browser.send("Page.navigate", { url: `${p.BASE}/settings/usage` });
  await until(() => browser.evaluate(`Boolean(document.querySelector('button[aria-label="Refresh usage"]'))`) as Promise<boolean>, "the refresh button", 30);
  const idle = await browser.evaluate(`(() => { const button = document.querySelector('button[aria-label="Refresh usage"]'); return { busy: button.getAttribute("aria-busy"), spinning: Boolean(button.querySelector(".animate-spin")) }; })()`) as { busy: string | null; spinning: boolean };
  check("buttonAtRest", idle.busy === null && !idle.spinning, idle);

  const before = reads();
  const clickedAt = Date.now();
  // Three quick clicks are one refresh.
  await browser.evaluate(`(() => { const button = document.querySelector('button[aria-label="Refresh usage"]'); button.click(); return true; })()`);
  await call("usage:requestRefresh", { key: KEY });
  await call("usage:requestRefresh", { key: KEY });
  await until(async () => (await browser.evaluate(`document.querySelector('section[aria-label="Your plans"]').innerText`) as string).includes("63"), "the new five-hour number on the page", 30);
  const tookMs = Date.now() - clickedAt;
  check("clickReadsNow", tookMs < 20_000 && JSON.stringify(await codexPercents()) === "[63,71]", { tookMs, percents: await codexPercents() });
  await sleep(4_000);
  check("quickClicksReadOnce", reads() - before === 1, { readsForClicks: reads() - before });
  await until(async () => !(await browser.evaluate(`Boolean(document.querySelector('button[aria-label="Refresh usage"] .animate-spin'))`) as boolean), "the spinner to stop", 30);
  check("spinnerStops", true);
  await p.shot("usage-refreshed.png", 'section[aria-label="Your plans"]');

  check("noPageErrors", browser.errors.length === 0, browser.errors.slice(0, 5));
} catch (error) {
  p.notes.stoppedAt = String(error);
}
const passed = await p.finish({ engine: "codex", agent: "stand-in (artifacts/choose-engine/fake-cli.ts)" });
process.exit(passed ? 0 : 1);
