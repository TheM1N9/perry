import assert from "node:assert/strict";
import { BrowserWindow, ipcMain } from "electron";
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { meetingNotice } from "../../../pet/meeting-notice.js";
import { noticeCalls } from "../../../pet/notice-calls.js";

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
  let stopProbe;
  let foreign;
  const count = ipcMain.listenerCount("meeting-notice:action");
  const notice = meetingNotice({ here: join(root, "pet"),
    start: async (ask) => { started = true; result = await ears.start(ask); return result; },
    dismiss: (eventId) => call("meetings:dismissUpcoming", { eventId }), open: () => {},
  });
  try {
    const observed = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("The native call probe did not answer.")), 20_000);
      stopProbe = noticeCalls((state) => { clearTimeout(timeout); resolve(state); });
    });
    stopProbe();
    report.callProbe = observed;
    report.checks.nativeCallProbeAnswered = typeof observed.active === "boolean";
    const config = { paused: false, headsUp: true, notice: true, upcoming: [] };
    notice.configure(config);
    notice.call({ active: true, app: "Zoom" });
    const banner = await waitFor(() => BrowserWindow.getAllWindows().find((window) => window.getTitle() === "Perry meeting" && window.isVisible()));
    await waitFor(async () => banner.webContents.executeJavaScript("document.querySelector('main').hidden === false"));
    report.checks.promptShowsWithoutFocus = !banner.isFocused();
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
    notice.listening({ phase: "listening" });
    report.checks.recordingHidesPrompt = !banner.isVisible();
    notice.listening({ phase: "off" });
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
