import { app, BrowserWindow, ipcMain, session } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listener } from "../../../pet/listen.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const home = process.env.PERRY_HOME;
const output = process.env.PERRY_MEETING_PROBE_OUT;
app.setPath("userData", join(home, "electron-profile"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
const report = { phase: "boot", pid: process.pid, electron: process.versions.electron, platform: process.platform, states: [], segments: [], checks: {} };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ears;
let player;
let finishing = false;
let fixturePreload;
const deadline = setTimeout(() => { void finish(new Error("Native capture exceeded its three-minute deadline.")); }, 180_000);
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (error) report.error = String(error.stack ?? error);
  ears?.dispose();
  if (fixturePreload) session.fromPartition("perry-listening").unregisterPreloadScript(fixturePreload);
  ipcMain.removeAllListeners("ci:microphone-fixture");
  if (player && !player.isDestroyed()) player.destroy();
  for (let at = 0; at < 40 && app.getAppMetrics().some((item) => item.name === "Perry listening"); at++) await sleep(50);
  report.checks.windowsClosed = BrowserWindow.getAllWindows().length === 0;
  report.checks.workerExited = !app.getAppMetrics().some((item) => item.name === "Perry listening");
  report.checks.ipcReleased = ipcMain.listenerCount("meeting:chunk") === 0 && ipcMain.listenerCount("meeting:status") === 0;
  report.phase = "done";
  report.passed = !report.error && Object.values(report.checks).every(Boolean);
  save();
  app.exit(report.passed ? 0 : 1);
}
save();

app.whenReady().then(async () => {
  try {
    // A per-session microphone fixture leaves Chromium's real OS loopback untouched.
    const hearing = session.fromPartition("perry-listening");
    ipcMain.on("ci:microphone-fixture", (event) => {
      if (event.sender.session === hearing) event.returnValue = readFileSync(join(home, "you.wav")).toString("base64");
      else event.returnValue = null;
    });
    fixturePreload = hearing.registerPreloadScript({ type: "frame", filePath: join(root, "artifacts/meetings/probe/microphone.cjs") });
    const call = async (path, args) => {
      const response = await fetch(`${process.env.PERRY_URL}/api/backend/call`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ path, args: { ...args, key: process.env.DASHBOARD_KEY } }), signal: AbortSignal.timeout(15_000),
      });
      const body = await response.json();
      if (!response.ok) throw new Error(`${path}: ${body.error}`);
      if (path === "meetings:start") report.meetingId = body.value.id;
      if (path === "meetings:appendSegments") report.segments.push(...args.segments);
      return body.value;
    };
    ears = listener({ here: join(root, "pet"), models: process.env.PERRY_MODELS_DIR, call, tell: (state) => {
      report.state = state;
      report.states.push(state);
      if (report.states.length > 30) report.states.shift();
      save();
    } });
    const state = await ears.start({ title: "CI synthetic meeting" });
    report.initial = state;
    if (state.phase !== "listening" || state.mic !== "live") throw new Error(`Microphone capture did not start: ${JSON.stringify(state)}`);
    if (process.platform === "win32" && state.system !== "live") throw new Error(`WASAPI loopback did not start: ${state.system}`);

    const pet = new BrowserWindow({ show: false });
    await pet.loadURL("data:text/html,<title>Disposable pet UI</title>");
    pet.destroy();
    report.checks.survivesPetReload = ears.state().phase === "listening";
    report.phase = "capturing";
    save();
    await sleep(12_000);
    if (state.system === "live") {
      player = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" } });
      await player.loadURL("data:text/html,<title>Remote speech through the OS output</title>");
      const audio = `data:audio/wav;base64,${readFileSync(join(home, "them.wav")).toString("base64")}`;
      await player.webContents.executeJavaScript(`window.audio = new Audio(${JSON.stringify(audio)}); window.audio.play()`);
      await sleep(12_000);
    }
    // Stop must flush a final partial chunk, wait for Whisper, and retry a failed delivery.
    await ears.stop();
    for (let at = 0; at < 240 && ears.state().phase !== "off"; at++) await sleep(500);
    if (ears.state().phase !== "off") throw new Error("The transcript queue did not drain after Stop.");
    const you = report.segments.filter((part) => part.source === "you").map((part) => part.text).join(" ");
    const them = report.segments.filter((part) => part.source === "them").map((part) => part.text).join(" ");
    report.checks.microphoneTranscribed = /proposal|friday/i.test(you);
    if (state.system === "live") {
      report.checks.loopbackTranscribed = /budget|thousand|5[,.]?000/i.test(them);
      report.checks.sourcesDistinct = !/proposal|friday/i.test(them) && !/budget|thousand|5[,.]?000/i.test(you);
      report.loopbackCoverage = report.checks.loopbackTranscribed ? "verified" : "failed";
    } else {
      report.loopbackCoverage = "permission-blocked";
      report.checks.partialCaptureExplained = process.platform === "darwin" && /notallowed|permission|denied|no audio|ended/i.test(state.system);
    }
    await finish();
  } catch (error) { await finish(error); }
}).catch((error) => { void finish(error); });
