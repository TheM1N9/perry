import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// bun artifacts/screen-look/look.ts <outDir>
// Issue #152: the pet's own picture-taking (pet/look.js) in real Electron,
// with no Perry server and no Codex, started the way `perry pet` starts him
// (scripts/pet.ts, launch). On the owner's Windows computer, and in CI on
// macOS (a throwaway machine, where it may put Calculator in front). Needs
// the pet installed: pnpm install --dir pet.
//
// Ways it could fail, written down before the checks:
//   1. On a Mac without Screen Recording, the picture throws Electron's
//      "Failed to get sources.", or comes back as the bare desktop, rather
//      than saying what to allow: it must say needs "screen-recording", name
//      the app in System Settings → Privacy & Security, and say to restart.
//   2. The message names the wrong app (the pet's package name, or the
//      terminal): it must be the .app Electron runs from, and that app must
//      be Electron's own, com.github.Electron.
//   3. What the owner allowed is lost at the next Electron update: Electron's
//      designated requirement must name its identifier and team only, not a
//      version or a hash of this build.
//   4. Started by `perry pet`, the pet is the terminal's for macOS, not its
//      own app: it must be started through `open` (its parent is launchd),
//      and where sudo is allowed, `launchctl procinfo` must name Electron as
//      responsible for it. Started the old way, the terminal's runner is.
//   5. Through `open`, Perry's settings do not reach it (PERRY_HOME,
//      PERRY_PORT): it would use the owner's own pet's storage and server.
//   6. The window-in-front lookup fails on a Mac (osascript, the AppKit or
//      CoreGraphics bridge), or takes too long: it must name a window and
//      its app, in under five seconds, and the app put in front must be it.
//   7. The picture is of the wrong window (his own, an overlay on top of
//      everything) or empty, or his window stays see-through: on Windows it
//      must be the one in front as user32 says, apart from Perry (or, when
//      that one cannot be pictured, one that does not let clicks through),
//      and the screen more than 20 KB. Asked twice, the same answer.
//   8. The real pet (pet/main.js, started by the same launch against a
//      stand-in /pet page) does not hand his page what look.js says, for
//      Perry's tool or for the owner's button; or on a Mac, after macOS has
//      asked once, the owner asking again does not open System Settings.
//   9. It touches the owner's own pet: other Electron processes must be
//      untouched; the probe and the pet keep their storage in their own
//      PERRY_HOME, and the pet stands away from the owner's.
//
// No picture is kept: only sizes and window ids (the probe writes no image).

const [outDir] = process.argv.slice(2);
if (!outDir) throw new Error("usage: bun artifacts/screen-look/look.ts <outDir>");
mkdirSync(outDir, { recursive: true });

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const PROBE = join(REPO, "artifacts", "screen-look", "probe");
const freePort = () => new Promise<number>((done) => { const probe = createServer().listen(0, "127.0.0.1", () => { const { port } = probe.address() as { port: number }; probe.close(() => done(port)); }); });
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
async function until(test: () => Promise<boolean>, seconds: number) {
  for (let i = 0; i < seconds * 2; i++) {
    if (await test().catch(() => false)) return;
    await sleep(500);
  }
  throw new Error("timed out");
}
const home = mkdtempSync(join(tmpdir(), "perry-look-probe-"));
// Set before scripts/pet.ts is loaded: it (and scripts/perry.ts) read them as they load.
process.env.PERRY_HOME = home;
process.env.PERRY_PORT = String(await freePort());
delete process.env.ELECTRON_RUN_AS_NODE;
const { electron, launch } = await import("../../scripts/pet");

const mac = process.platform === "darwin";
const windows = process.platform === "win32";
const checks: Record<string, boolean> = {};
const notes: Record<string, unknown> = {};
const check = (name: string, ok: boolean, note?: unknown) => { checks[name] = ok; if (note !== undefined) notes[name] = note; };
const text = (argv: string[]) => { const ran = spawnSync(argv[0], argv.slice(1), { encoding: "utf8", windowsHide: true }); return `${ran.stdout ?? ""}${ran.stderr ?? ""}`.trim(); };

/** Electron processes on this computer that are not this checkout's: the owner's own pet among them. */
const otherElectrons = () => windows
  ? text(["powershell", "-NoProfile", "-NonInteractive", "-Command", `Get-CimInstance Win32_Process -Filter "Name='electron.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' -and $_.CommandLine -notlike '*${REPO.replace(/'/g, "''")}*' } | ForEach-Object { $_.ProcessId }`]).split(/\s+/).filter(Boolean).sort()
  : text(["pgrep", "-f", "Electron.app/Contents/MacOS/Electron"]).split(/\s+/).filter(Boolean).filter((pid) => !text(["ps", "-o", "command=", "-p", pid]).includes(REPO)).sort();
/** On Windows, the window in front as user32 says, and whether a window lets clicks through: read apart from look.js, to check it. */
function user32(handle?: number): { front: number; through: boolean } {
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class T { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern int GetWindowLong(IntPtr h, int i); }'",
    `ConvertTo-Json -Compress @{ front = [T]::GetForegroundWindow().ToInt64(); through = ${handle ? `(([T]::GetWindowLong([IntPtr][long]${handle}, -20) -band 0x20) -ne 0)` : "$false"} }`,
  ].join("; ");
  return JSON.parse(text(["powershell", "-NoProfile", "-NonInteractive", "-Command", script]));
}
/** Which process macOS holds responsible for `pid` (for its permissions): launchctl procinfo, which needs root; null without sudo. */
function responsible(pid: number): string | null {
  const info = text(["sudo", "-n", "launchctl", "procinfo", String(pid)]);
  const path = info.match(/responsible path = (.+)/)?.[1]?.trim();
  return path ?? null;
}

type Round = { ms: number; threw?: string; error?: string; needs?: string; frontListed?: boolean; window?: { id: string; bytes: number; isTheStandIn: boolean; name?: string }; screen?: { bytes: number }; standInOpacityAfter: number };
type Report = { pid: number; ppid: number; execPath: string; macApp: string; env: Record<string, string | null>; screenAccess?: string; front?: { front: number | null; app?: string | null; order?: number[]; through?: number[] } | null; frontMs?: number; first?: Round; again?: Round; done?: boolean };

/** Run the probe, started as `how` says; its report, and who macOS holds responsible for it. */
async function probe(program: string, how: "as perry pet does" | "directly, as before"): Promise<{ report: Report | null; responsible: string | null }> {
  const out = join(home, `${how.startsWith("as") ? "launched" : "direct"}.json`);
  process.env.PERRY_LOOK_CHECK_OUT = out;
  if (how === "as perry pet does") launch(program, [], PROBE);
  else spawn(program, [PROBE], { cwd: PROBE, env: process.env, detached: true, stdio: "ignore" }).unref();
  const read = () => { try { return JSON.parse(readFileSync(out, "utf8")) as Report; } catch { return null; } };
  let owner: string | null = null;
  for (let i = 0; i < 120; i++) {
    const report = read();
    if (report && mac && owner === null) owner = responsible(report.pid) ?? "";
    if (report?.done) return { report, responsible: owner || null };
    await sleep(500);
  }
  return { report: read(), responsible: owner || null };
}

const before = otherElectrons();
try {
  const program = await electron();
  if (!program.path) throw new Error(`no Electron: ${program.error} (pnpm install --dir pet)`);
  notes.electron = program.path.replace(REPO, "<repo>");

  if (mac) {
    const bundle = program.path.match(/^(.*\.app)\/Contents\/MacOS\//)?.[1] ?? "";
    const id = text(["defaults", "read", join(bundle, "Contents", "Info"), "CFBundleIdentifier"]);
    const requirement = text(["codesign", "-d", "-r-", bundle]);
    check("macAppIsElectronsOwn", bundle.endsWith("/Electron.app") && id === "com.github.Electron", { bundle: bundle.replace(REPO, "<repo>"), id });
    // What TCC keeps with a permission: an identifier and a team hold across versions; a cdhash would not.
    check("permissionOutlivesUpdates", /identifier "com\.github\.Electron"/.test(requirement) && /subject\.OU/.test(requirement) && !/cdhash/.test(requirement), requirement);
    if (process.env.CI) {
      // A throwaway machine: an app of its own in front, to know which the lookup must name.
      spawnSync("open", ["-a", "Calculator"]);
      await sleep(3_000);
    }
  }

  const frontBefore = windows ? user32().front : null;
  const launched = await probe(program.path, "as perry pet does");
  const frontAfter = windows ? user32().front : null;
  const report = launched.report;
  notes.launched = launched;
  if (!report?.done) throw new Error("the probe did not finish");
  check("settingsReachIt", report.env.PERRY_HOME === home && report.env.PERRY_PORT === process.env.PERRY_PORT, report.env);

  if (mac) {
    check("startedAsItsOwnApp", report.ppid === 1 && (launched.responsible === null || launched.responsible.endsWith("Electron.app/Contents/MacOS/Electron")), { ppid: report.ppid, responsible: launched.responsible });
    const found = report.front;
    check("frontWindowOnMac", typeof found?.front === "number" && typeof found.app === "string" && found.order?.[0] === found.front && (report.frontMs ?? 9e9) < 5_000
      && (!process.env.CI || found.app === "Calculator"), { ...found, order: found?.order?.length, ms: report.frontMs });
    const rounds = [report.first!, report.again!];
    if (report.screenAccess === "granted") {
      // Allowed (not on CI's machines so far): the picture must be the app put in front.
      check("macPicture", rounds.every((round) => !round.threw && !round.error && (round.screen?.bytes ?? 0) > 20_000 && round.window && !round.window.isTheStandIn && (!process.env.CI || round.window.name === "Calculator")), rounds);
    } else {
      check("macSaysWhatToAllow", rounds.every((round) => !round.threw && round.needs === "screen-recording" && round.ms < 5_000
        && round.error?.includes(`“${report.macApp}”`) && round.error.includes("Privacy & Security") && round.error.includes("Screen Recording") && /restart/i.test(round.error)), rounds);
      check("macNamesTheAppItRunsIn", report.macApp === "Electron" && report.execPath.includes("Electron.app/Contents/MacOS/"), report.macApp);
    }
    notes.screenAccess = report.screenAccess;
    // The way it was started before this fix, from this terminal: who macOS held responsible then.
    const direct = await probe(program.path, "directly, as before");
    notes.directlyAsBefore = { ppid: direct.report?.ppid, responsible: direct.responsible, screenAccess: direct.report?.screenAccess, first: direct.report?.first && { needs: direct.report.first.needs, window: Boolean(direct.report.first.window), screen: direct.report.first.screen?.bytes } };
  }

  if (windows) {
    const steady = frontBefore === frontAfter;
    const rounds = [report.first!, report.again!];
    const ok = rounds.map((round) => {
      const chosen = Number(round.window?.id.split(":")[1]);
      const isTheFront = round.window?.id === `window:${frontBefore}:0`;
      const clickThrough = Number.isFinite(chosen) ? user32(chosen).through : null;
      return { ok: !round.threw && !round.error && !round.window?.isTheStandIn && (round.window?.bytes ?? 0) > 3_000 && (round.frontListed ? isTheFront : clickThrough === false), isTheFront, frontListed: round.frontListed, clickThrough, windowBytes: round.window?.bytes };
    });
    // The owner may switch windows meanwhile; then the check says so rather than failing.
    check("windowsPictureIsTheWindowInFront", !steady || ok.every((round) => round.ok), { steady, rounds: ok });
    check("windowsScreenPicture", rounds.every((round) => (round.screen?.bytes ?? 0) > 20_000), rounds.map((round) => round.screen?.bytes));
    check("windowsFrontLookup", report.front?.front === frontBefore || !steady, { front: report.front?.front === frontBefore, ms: report.frontMs });
  }
  check("hisWindowNeverInThePicture", [report.first, report.again].every((round) => round && !round.window?.isTheStandIn && round.standInOpacityAfter === 1));

  // --- The real pet (pet/main.js), asked through his page's bridge as his chat's button and Perry's tool ask ---
  // A stand-in for Perry's server: an empty /pet page, for his window to load and his bridge to be in.
  const page = createServer((_request, response) => { response.writeHead(200, { "content-type": "text/html" }); response.end("<!doctype html><title>stand-in</title><body style='background:transparent'></body>"); });
  const pagePort = await freePort();
  await new Promise<void>((done) => page.listen(pagePort, "127.0.0.1", done));
  const devtools = await freePort();
  process.env.PERRY_URL = `http://127.0.0.1:${pagePort}`;
  process.env.PERRY_PET_DEVTOOLS_PORT = String(devtools);
  // Away from the bottom-right corner, where the owner's own pet may be standing.
  writeFileSync(join(home, "pet.json"), JSON.stringify({ x: 40, y: 60 }));
  const settingsBefore = mac ? text(["pgrep", "-x", "System Settings"]) : "";
  launch(program.path);
  try {
    let target: { url: string; webSocketDebuggerUrl: string } | undefined;
    for (let i = 0; i < 120 && !target; i++) {
      const list = await fetch(`http://127.0.0.1:${devtools}/json/list`).then((r) => r.json() as Promise<Array<{ url: string; webSocketDebuggerUrl: string }>>, () => []);
      target = list.find((item) => item.url.startsWith(`${process.env.PERRY_URL}/pet`));
      if (!target) await sleep(500);
    }
    if (!target) throw new Error("the real pet's page did not open");
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((done) => ws.addEventListener("open", done, { once: true }));
    let id = 0;
    const evaluate = (expression: string) => new Promise<unknown>((done) => {
      const n = ++id;
      const onMessage = (event: MessageEvent) => { const message = JSON.parse(String(event.data)); if (message.id === n) { ws.removeEventListener("message", onMessage); done(message.result?.result?.value); } };
      ws.addEventListener("message", onMessage);
      ws.send(JSON.stringify({ id: n, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
    });
    // Sizes only: the pictures themselves stay in his page.
    const ask = (byOwner: boolean) => evaluate(`(async () => { const s = await window.perryPet.look(${byOwner}); return { error: s.error, needs: s.needs, frontListed: s.frontListed, window: s.window && { id: s.window.id, bytes: s.window.image.length }, screen: s.screen && s.screen.image.length }; })()`) as Promise<{ error?: string; needs?: string; frontListed?: boolean; window?: { id: string; bytes: number }; screen?: number }>;
    await until(() => evaluate("typeof window.perryPet?.look === 'function'").then(Boolean), 30);
    const forPerry = await ask(false);
    const asked = JSON.parse(readFileSync(join(home, "pet.json"), "utf8")) as { screenRecordingAsked?: boolean };
    const forOwner = await ask(true);
    ws.close();
    if (mac && forPerry.needs) {
      // Macos asked the first time (Perry's ask); the owner asking again opens System Settings where they allow it.
      await sleep(3_000);
      const settingsNow = text(["pgrep", "-x", "System Settings"]);
      check("realPetSaysWhatToAllow", forPerry.needs === "screen-recording" && forOwner.needs === "screen-recording" && Boolean(forOwner.error?.includes("“Electron”")) && asked.screenRecordingAsked === true, { forPerry, forOwner, asked: asked.screenRecordingAsked });
      check("ownerIsTakenToSettings", !process.env.CI || (Boolean(settingsNow) && settingsNow !== settingsBefore), { before: settingsBefore, now: settingsNow });
    } else {
      check("realPetTakesThePicture", [forPerry, forOwner].every((shot) => !shot.error && (shot.screen ?? 0) > 20_000 && (shot.window?.bytes ?? 0) > 3_000), { forPerry, forOwner });
    }
  } finally {
    launch(program.path, ["--quit"]);
    await until(() => fetch(`http://127.0.0.1:${devtools}/json/list`).then(() => false, () => true), 20).catch(() => {});
    page.close();
  }
} catch (error) {
  notes.stoppedAt = String(error);
  checks.completed = false;
} finally {
  await sleep(1_000);
  check("ownersPetUntouched", JSON.stringify(otherElectrons()) === JSON.stringify(before), { before: before.length });
  try { rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
}

const result = { ranAt: new Date().toISOString(), platform: `${process.platform} ${process.arch}`, checks, notes, passed: Object.values(checks).every(Boolean) };
// Where this checkout and the scratch home are says nothing about the check: left out.
const scrubbed = [[REPO, "<repo>"], [home, "<home>"]].reduce((json, [from, to]) => json.split(JSON.stringify(from).slice(1, -1)).join(to), JSON.stringify(result, null, 2));
writeFileSync(join(outDir, `look-${process.platform}.json`), `${scrubbed}\n`);
console.log(scrubbed);
process.exit(result.passed ? 0 : 1);
