import { app, BrowserWindow, ipcMain, session, systemPreferences, utilityProcess, webContents } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { listener } from "../../../pet/listen.js";
import { noticeFlow } from "./notice-flow.js";
import { cloudErrors } from "./cloud-errors.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const home = process.env.PERRY_HOME;
const output = process.env.PERRY_MEETING_PROBE_OUT;
app.setPath("userData", join(home, "electron-profile"));
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// Like the tray pet, keep saving after the last capture window has closed.
app.on("window-all-closed", () => {});
const report = { phase: "boot", pid: process.pid, electron: process.versions.electron, platform: process.platform, states: [], segments: [], nativeOperations: [], checks: {} };
const save = () => writeFileSync(output, JSON.stringify(report, null, 2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let ears;
let player;
let finishing = false;
let fixturePreload;
/** Whether sound reached the capture page at all, and whether the fixture's clock ran: what tells a silent run from a transcription fault. */
const heard = { reports: 0, loudestMic: 0, loudestSystem: 0, fixture: [] };
const hearReport = (_event, status) => {
  if (!status?.peak) return;
  heard.reports += 1;
  heard.loudestMic = Math.max(heard.loudestMic, status.peak.mic);
  heard.loudestSystem = Math.max(heard.loudestSystem, status.peak.system);
};
const fixtureClock = async () => {
  const hearing = webContents.getAllWebContents().find((contents) => contents.session === session.fromPartition("perry-listening"));
  if (!hearing || hearing.isDestroyed()) return;
  heard.fixture.push(await hearing.executeJavaScript("({ started: window.ciMicrophoneStarted ?? null, state: window.ciMicrophone?.context.state ?? 'closed', at: window.ciMicrophone?.context.currentTime ?? null })").catch((error) => String(error)));
  save();
};
const deadline = setTimeout(() => { void finish(new Error("Native capture exceeded its deadline.")); }, process.env.PERRY_MEETING_LARGE_PROBE === "1" ? 660_000 : 480_000);
async function finish(error) {
  if (finishing) return;
  finishing = true;
  clearTimeout(deadline);
  if (error) { report.error = String(error.stack ?? error); save(); }
  ears?.dispose();
  ipcMain.off("meeting:status", hearReport);
  report.heard = heard;
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
    // Journal entry and return around native teardown calls: a blocked main thread
    // cannot run a timeout, but the parent can still upload the last saved operation.
    const destroying = BrowserWindow.prototype.destroy;
    BrowserWindow.prototype.destroy = function (...args) {
      const operation = { type: "window.destroy", title: this.getTitle(), enteredAt: Date.now() };
      report.nativeOperations.push(operation);
      save();
      const result = destroying.apply(this, args);
      operation.returnedAt = Date.now();
      save();
      return result;
    };
    const fork = utilityProcess.fork.bind(utilityProcess);
    utilityProcess.fork = (module, args, options) => {
      const worker = fork(module, args, { ...options, stdio: "pipe" });
      worker.on("message", (message) => {
        if (message.type === "done") { report.inference ??= []; report.inference.push({ seq: message.seq, ms: message.ms }); save(); }
      });
      let log = "";
      const append = (data) => { log = (log + data).slice(-64_000); writeFileSync(join(dirname(output), "worker.log"), log); };
      worker.stdout?.on("data", append);
      worker.stderr?.on("data", append);
      worker.once("exit", (code) => { report.workerExit = { code, at: Date.now() }; save(); });
      const kill = worker.kill.bind(worker);
      worker.kill = () => {
        const operation = { type: "worker.kill", enteredAt: Date.now() };
        report.nativeOperations.push(operation);
        save();
        const result = kill();
        operation.returnedAt = Date.now();
        save();
        return result;
      };
      return worker;
    };
    if (process.platform === "darwin") report.screenAccess = systemPreferences.getMediaAccessStatus("screen");
    // A per-session microphone fixture leaves Chromium's real OS loopback untouched.
    const hearing = session.fromPartition("perry-listening");
    ipcMain.on("ci:microphone-fixture", (event) => {
      if (event.sender.session === hearing) event.returnValue = readFileSync(join(home, "you.wav")).toString("base64");
      else event.returnValue = null;
    });
    fixturePreload = hearing.registerPreloadScript({ type: "frame", filePath: join(root, "artifacts/meetings/probe/microphone.cjs") });
    const fault = { kind: null, attempts: 0 };
    const call = async (path, args) => {
      if (path === "speech:transcribe" && fault.kind) {
        fault.attempts++;
        if (fault.kind === "missing") throw new Error("Add a Groq speech key in Settings, or select the local model.");
        if (fault.kind === "stopping") { await new Promise((resolve) => setTimeout(resolve, 250)); throw new Error("Groq rejected the speech key. Update it in Settings."); }
        if (fault.kind === "rejected") throw new Error("Groq rejected the speech key. Update it in Settings.");
        if (fault.attempts === 1) throw new Error(fault.kind === "invalid" ? "Invalid speech chunk." : "Groq's speech limit was reached. The audio chunk will be retried.");
      }
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
      report.states.push({ at: Date.now(), ...state });
      if (report.states.length > 30) report.states.shift();
      save();
    } });
    report.heard = heard;
    ipcMain.on("meeting:status", hearReport);
    report.phase = "opening-capture";
    save();
    const state = await noticeFlow({ root, output, call, ears, report, save });
    report.initial = state;
    if (state.phase !== "listening" || state.mic !== "live") throw new Error(`Microphone capture did not start: ${JSON.stringify(state)}`);
    if (process.platform === "win32" && state.system !== "live") throw new Error(`WASAPI loopback did not start: ${state.system}`);

    const pet = new BrowserWindow({ show: false });
    await pet.loadURL("data:text/html,<title>Disposable pet UI</title>");
    pet.destroy();
    report.checks.survivesPetReload = ears.state().phase === "listening";
    report.phase = "capturing";
    save();
    // Remote audio starts while the synthetic microphone is still speaking.
    await sleep(2_000);
    if (state.system === "live") {
      player = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false, autoplayPolicy: "no-user-gesture-required" } });
      await player.loadURL("data:text/html,<title>Remote speech through the OS output</title>");
      const audio = `data:audio/wav;base64,${readFileSync(join(home, "them.wav")).toString("base64")}`;
      await player.webContents.executeJavaScript(`window.audio = new Audio(${JSON.stringify(audio)}); window.audio.play()`);
    }
    await fixtureClock();
    await sleep(2_000);
    await fixtureClock();
    await sleep(10_000);
    if (player) { player.destroy(); player = null; }
    // The call app lets go of the microphone. Perry confirms it, waits for quiet, and counts down where the owner can
    // pause it (pointer resting on it) or keep going; a later call ending stops the notes by itself. Stopping must
    // still flush a final partial chunk, wait for Whisper, and retry a failed delivery.
    const until = async (read, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) { const value = read(); if (value) return value; } return null; };
    ears.callActive(true); ears.callActive(false);
    // Speech still being written down holds the countdown off; other sound playing on this computer does not.
    const endedAt = Date.now();
    // Paused the moment it is seen, so a slow machine cannot let the countdown run out between steps.
    report.checks.callEndCountsDown = Boolean(await until(() => {
      const now = ears.state();
      if (now.phase !== "listening" || !now.endingAt) return null;
      ears.holdEnding(true);
      return now;
    }, 150_000));
    report.callEndCountdownAfterMs = Date.now() - endedAt;
    report.checks.callEndPausesUnderPointer = ears.state().endingLeft > 0 && !ears.state().endingAt;
    await sleep(1_500);
    report.checks.callEndStaysPaused = ears.state().phase === "listening" && ears.state().endingLeft > 0;
    ears.holdEnding(false);
    ears.keepGoing();
    await sleep(1_500);
    report.checks.keepGoingCancelsCountdown = ears.state().phase === "listening" && !ears.state().endingAt && !ears.state().endingLeft;
    ears.callActive(true); ears.callActive(false);
    const stopped = await until(() => ears.state().phase !== "listening", 180_000);
    report.checks.callEndStopsNotes = Boolean(stopped);
    if (!stopped) await ears.stop();
    for (let at = 0; at < 240 && ears.state().phase !== "off"; at++) await sleep(500);
    if (ears.state().phase !== "off") throw new Error("The transcript queue did not drain after Stop.");
    const you = report.segments.filter((part) => part.source === "you").map((part) => part.text).join(" ");
    const spoken = report.segments.reduce((sum, part) => sum + part.text.split(/\s+/).filter(Boolean).length, 0);
    report.ended = ears.state().ended;
    report.checks.endedCountsWords = ears.state().ended?.id === report.meetingId && ears.state().ended?.words === spoken;
    ears.forgetEnded();
    report.checks.forgetEndedClears = !ears.state().ended;
    const them = report.segments.filter((part) => part.source === "them").map((part) => part.text).join(" ");
    const words = (text) => text.toLowerCase().replace(/\$5,?000/g, "five thousand dollars").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
    const wer = (actual, reference) => {
      const target = words(reference);
      let row = Array.from({ length: target.length + 1 }, (_, index) => index);
      for (const [index, word] of words(actual).entries()) {
        const next = [index + 1];
        for (let at = 0; at < target.length; at++) next.push(Math.min(next[at] + 1, row[at + 1] + 1, row[at] + Number(word !== target[at])));
        row = next;
      }
      return row[target.length] / target.length;
    };
    report.wordErrorRate = { you: wer(you, "I will send the revised proposal on Friday. Please confirm the proposal delivery date."), them: wer(them, "The approved budget is five thousand dollars. We agreed to keep the budget at five thousand dollars.") };
    report.checks.microphoneTranscribed = /proposal|friday/i.test(you);
    report.checks.microphonePhraseAccuracy = report.wordErrorRate.you <= 0.2;
    if (state.system === "live") {
      report.checks.loopbackTranscribed = /budget|thousand|5[,.]?000/i.test(them);
      report.checks.loopbackPhraseAccuracy = report.wordErrorRate.them <= 0.2;
      report.checks.sourcesDistinct = !/proposal|friday/i.test(them) && !/budget|thousand|5[,.]?000/i.test(you);
      report.loopbackCoverage = report.checks.loopbackTranscribed ? "verified" : "failed";
    } else {
      report.loopbackCoverage = "permission-blocked";
      report.checks.partialCaptureExplained = process.platform === "darwin" && /notallowed|permission|denied|no audio|ended/i.test(state.system);
    }
    if (process.env.PERRY_MEETING_CLOUD_PROBE === "1") {
      const meetingId = report.meetingId;
      const segments = report.segments.slice();
      await cloudErrors({ ears, fault, call, report, save });
      report.meetingId = meetingId;
      report.segments = segments;
    }
    await finish();
  } catch (error) { await finish(error); }
}).catch((error) => { void finish(error); });
