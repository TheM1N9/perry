import assert from "node:assert/strict";
import { BrowserWindow, ipcMain, screen } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { meetingNotice } from "../../../pet/meeting-notice.js";
import { noticeCalls } from "../../../pet/notice-calls.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (read) => {
  const until = Date.now() + 20_000;
  while (Date.now() < until) {
    const value = await read();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Meeting prompt did not reach the expected state.");
};

export async function noticeFlow({ root, output, call, ears, report, save }) {
  let result;
  let started = false;
  let finished = 0;
  let keptGoing = 0;
  let forgot = 0;
  let petAt = null;
  const holds = [];
  const discarded = [];
  const opened = [];
  let stopProbe;
  let foreign;
  const count = ipcMain.listenerCount("meeting-notice:action");
  const notice = meetingNotice({ here: join(root, "pet"),
    start: async (ask) => { started = true; result = await ears.start(ask); return result; },
    stop: () => { finished++; },
    keepGoing: () => { keptGoing++; }, holdEnding: (held) => { holds.push(held); }, forget: () => { forgot++; },
    discard: async (id) => { discarded.push(id); },
    anchor: () => petAt,
    dismiss: (eventId) => call("meetings:dismissUpcoming", { eventId }), open: (path) => { opened.push(path); },
  });
  try {
    const observed = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The native call probe did not answer.")), 20_000);
      stopProbe = noticeCalls((state) => { clearTimeout(timeout); resolve(state); }, (issue) => {
        clearTimeout(timeout);
        report.callProbeFailure = issue;
        save();
        reject(new Error(`Native call probe failed: ${issue.message}; stdout=${issue.stdout}; stderr=${issue.stderr}`));
      });
    });
    stopProbe();
    report.callProbe = observed;
    report.callDetectionCoverage = observed.unavailable ? "permission-blocked" : "probe-answered";
    report.checks.nativeCallProbeAnswered = typeof observed.active === "boolean";
    const config = { paused: false, headsUp: true, notice: true, upcoming: [] };
    notice.configure(config);
    notice.call({ active: true, app: "Zoom" });
    const banner = await waitFor(() => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Perry meeting" && window.isVisible()));
    await waitFor(async () => banner.webContents.executeJavaScript("document.querySelector('main').hidden === false"));
    report.checks.promptShowsWithoutFocus = !banner.isFocused();
    if (typeof banner.isContentProtected === "function") report.checks.promptHiddenFromScreenShare = banner.isContentProtected();
    const title = await banner.webContents.executeJavaScript("document.querySelector('h1').textContent");
    assert.equal(title, "Meeting detected");
    notice.configure({ ...config, paused: true });
    report.checks.pauseHidesPrompt = !banner.isVisible();
    notice.configure(config);
    foreign = new BrowserWindow({ show: false });
    ipcMain.emit("meeting-notice:action", { sender: foreign.webContents }, "start", "call:1");
    report.checks.foreignRendererCannotStart = !started;
    foreign.destroy(); foreign = null;
    await banner.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape'}))");
    await waitFor(() => !banner.isVisible());
    notice.configure(config);
    report.checks.dismissedCallStaysHidden = !banner.isVisible();
    notice.call({ active: false });
    notice.call({ active: true, app: "Zoom" });
    report.checks.nextCallCanPrompt = banner.isVisible();
    const text = (selector) => banner.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).textContent`);
    const shown = (selector) => banner.webContents.executeJavaScript(`!document.querySelector(${JSON.stringify(selector)}).hidden`);
    const click = (selector) => banner.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const pointer = (type) => banner.webContents.executeJavaScript(`document.querySelector("main").dispatchEvent(new MouseEvent("${type}"))`);
    // The close button, which works without the keyboard focus the prompt never takes.
    report.checks.promptHasCloseButton = await shown("#close");
    await click("#close");
    await waitFor(() => !banner.isVisible());
    report.checks.closeButtonDismisses = true;
    // A detected call asks for 20 s and then leaves the owner be; the pointer resting on it pauses that.
    notice.call({ active: false });
    notice.call({ active: true, app: "Zoom" });
    await waitFor(() => banner.isVisible());
    await sleep(1_000);
    await pointer("mouseenter");
    await sleep(21_000);
    report.checks.callPromptWaitsUnderPointer = banner.isVisible();
    await pointer("mouseleave");
    const leftAt = Date.now();
    await waitFor(() => !banner.isVisible());
    report.checks.callPromptExpiresAfterPointerLeaves = Date.now() - leftAt >= 2_500;
    notice.call({ active: false });
    // Starting: Cancel works while audio connects.
    notice.listening({ phase: "starting", title: "Product planning", startedAt: Date.now() });
    await waitFor(async () => banner.isVisible() && await text("#start-label") === "Cancel" && await banner.webContents.executeJavaScript("!document.querySelector('#start').disabled"));
    await click("#start");
    await waitFor(() => finished === 1);
    report.checks.cancelWhileConnecting = true;
    notice.listening({ phase: "listening", title: "Product planning", startedAt: Date.now() - 65_000, speech: "Local transcription", mic: "live", system: "System audio needs permission." });
    await waitFor(async () => await text("#start-label") === "Stop");
    report.checks.recordingReplacesPromptWithControls = banner.isVisible();
    report.checks.recordingShowsMicOnly = /Mic only/.test(await text("#detail"));
    writeFileSync(join(dirname(output), "recording-controls.png"), (await banner.webContents.capturePage()).toPNG());
    await click("#start");
    await waitFor(() => finished === 2);
    report.checks.recordingFinishAction = true;
    // The call ended: a countdown with Keep going and Stop now, paused under the pointer.
    notice.listening({ phase: "listening", id: "meeting-b", title: "Product planning", startedAt: Date.now() - 65_000, mic: "live", system: "live", endingAt: Date.now() + 12_000 });
    await waitFor(async () => await text("h1") === "Call ended" && await text("#start-label") === "Keep going" && await shown("#second"));
    report.checks.callEndShowsCountdown = /Stopping notes in \d+s/.test(await text("#detail"));
    writeFileSync(join(dirname(output), "call-ended.png"), (await banner.webContents.capturePage()).toPNG());
    await pointer("mouseenter");
    await pointer("mouseleave");
    await waitFor(() => holds.length === 2);
    report.checks.callEndHoverHolds = holds[0] === true && holds[1] === false;
    await click("#start");
    await waitFor(() => keptGoing === 1);
    // Long quiet asks the same way.
    notice.listening({ phase: "listening", id: "meeting-b", title: "Product planning", startedAt: Date.now() - 900_000, mic: "live", system: "live", endingAt: Date.now() + 28_000, ending: "quiet" });
    await waitFor(async () => await text("h1") === "Meeting still going?");
    report.checks.quietAsksStillGoing = /No one has spoken for 10 min · Stopping notes in \d+s/.test(await text("#detail"));
    await click("#second");
    await waitFor(() => finished === 3);
    report.checks.callEndKeepGoingAndStopNow = true;
    // Too short to be a meeting: offered for throwing away.
    notice.listening({ phase: "off", ended: { id: "meeting-a", words: 3, at: Date.now() } });
    await waitFor(async () => banner.isVisible() && await text("h1") === "Started by mistake?");
    report.checks.mistakeSaysWords = /Only 3 words/.test(await text("#detail"));
    writeFileSync(join(dirname(output), "started-by-mistake.png"), (await banner.webContents.capturePage()).toPNG());
    // Discard can be undone for a few seconds; only then does the meeting go.
    // As the real listener does, once told to forget: the offer is over either way.
    await click("#second");
    await waitFor(async () => await text("h1") === "Recording discarded" && forgot === 1);
    notice.listening({ phase: "off" });
    report.checks.discardWaitsForUndo = discarded.length === 0;
    await click("#start");
    await waitFor(() => !banner.isVisible());
    await sleep(6_500);
    report.checks.undoKeepsTheMeeting = discarded.length === 0;
    notice.listening({ phase: "off", ended: { id: "meeting-a", words: 3, at: Date.now() } });
    await waitFor(async () => banner.isVisible() && await text("h1") === "Started by mistake?");
    await click("#second");
    await waitFor(async () => await text("h1") === "Recording discarded" && forgot === 2);
    notice.listening({ phase: "off" });
    await click("#close");
    await waitFor(() => discarded.length === 1);
    report.checks.mistakeDiscardsThatMeeting = discarded[0] === "meeting-a";
    // A new recording during the Undo window must not hold up the discard, which the server refuses once it is old.
    notice.listening({ phase: "off", ended: { id: "meeting-c", words: 2, at: Date.now() } });
    await waitFor(async () => banner.isVisible() && await text("h1") === "Started by mistake?");
    await click("#second");
    await waitFor(async () => await text("h1") === "Recording discarded");
    notice.listening({ phase: "listening", id: "meeting-d", title: "Next call", startedAt: Date.now(), mic: "live", system: "live" });
    await waitFor(() => discarded.length === 2);
    report.checks.discardGoesThroughDuringTheNextRecording = discarded[1] === "meeting-c";
    notice.listening({ phase: "off" });
    notice.listening({ phase: "off" });
    await waitFor(() => !banner.isVisible());
    // With the pet on screen, the card comes up beside him rather than in the corner.
    const { workArea } = screen.getPrimaryDisplay();
    petAt = { x: workArea.x + workArea.width - 220, y: workArea.y + workArea.height - 300, width: 150, height: 170 };
    // Notes written: said only for a meeting this pet recorded (meeting-b, above), once.
    notice.written({ id: "meeting-elsewhere", title: "Another computer's call" });
    await sleep(300);
    report.checks.readyOnlyForOwnRecordings = !banner.isVisible();
    notice.written({ id: "meeting-b", title: "Product planning" });
    await waitFor(async () => banner.isVisible() && await text("h1") === "Your notes are ready");
    report.checks.cardComesUpBesideThePet = banner.getBounds().x === petAt.x - banner.getBounds().width + 12;
    petAt = null;
    writeFileSync(join(dirname(output), "notes-ready.png"), (await banner.webContents.capturePage()).toPNG());
    await click("#start");
    await waitFor(() => opened.length === 1 && !banner.isVisible());
    report.checks.readyOpensNotes = opened[0] === "/meetings/meeting-b";
    notice.written({ id: "meeting-b", title: "Product planning" });
    await sleep(300);
    report.checks.readySaidOnce = !banner.isVisible();
    notice.call({ active: false });
    const upcoming = (await call("meetings:pet", {})).upcoming;
    assert.ok(upcoming.length);
    notice.configure({ ...config, upcoming: [{ ...upcoming[0], title: "CI <b>calendar</b> meeting" }] });
    await waitFor(() => banner.isVisible());
    await waitFor(() => banner.webContents.executeJavaScript("document.querySelector('h1').textContent === 'CI <b>calendar</b> meeting'"));
    report.checks.calendarTitleIsText = await banner.webContents.executeJavaScript("document.querySelector('h1 b') === null");
    writeFileSync(join(dirname(output), "meeting-prompt.png"), (await banner.webContents.capturePage()).toPNG());
    // The actual click starts the production capture window, worker and backend meeting.
    await banner.webContents.executeJavaScript("document.querySelector('#start').click()");
    await waitFor(() => result);
    report.checks.promptClickStartsCapture = started && result.phase === "listening" && !banner.isVisible();
    save();
    return result;
  } finally {
    stopProbe?.();
    foreign?.destroy();
    notice.dispose();
    report.checks.promptIpcReleased = ipcMain.listenerCount("meeting-notice:action") === count;
    report.checks.promptWindowReleased = !BrowserWindow.getAllWindows().some((window) => window.getTitle() === "Perry meeting");
    save();
  }
}
