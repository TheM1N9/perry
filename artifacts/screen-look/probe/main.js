/**
 * Started by artifacts/screen-look/look.ts the way `perry pet` starts the pet
 * (scripts/pet.ts, launch), this runs the pet's own look.js in real Electron:
 * a stand-in for his window on top, the window in front, and a picture, as
 * the Look hotkey takes it. It writes what it found to PERRY_LOOK_CHECK_OUT
 * and quits. No picture is written: only sizes and window ids, since on the
 * owner's computer they would be of whatever the owner has open.
 */

import { app, BrowserWindow, screen, systemPreferences } from "electron";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { MAC_APP, capture, inFront } from "../../../pet/look.js";

const OUT = process.env.PERRY_LOOK_CHECK_OUT;
// Its own storage, in the check's PERRY_HOME: never the pet's.
app.setPath("userData", join(process.env.PERRY_HOME ?? app.getPath("temp"), "look-probe"));
const report = { pid: process.pid, ppid: process.ppid, execPath: process.execPath, macApp: MAC_APP, env: { PERRY_HOME: process.env.PERRY_HOME ?? null, PERRY_PORT: process.env.PERRY_PORT ?? null } };
const write = () => { if (OUT) writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`); };
const bytes = (picture) => picture ? Math.round(picture.image.length * 3 / 4) : 0;

app.whenReady().then(async () => {
  // Written at once too, so the check can look at this process while it runs.
  write();
  if (process.platform === "darwin") {
    app.dock?.hide();
    report.screenAccess = systemPreferences.getMediaAccessStatus("screen");
  }
  // The window in front, asked the way the picture asks it.
  const started = Date.now();
  report.front = await inFront().ask([]);
  report.frontMs = Date.now() - started;

  // A stand-in for his window: on top, in the corner, never taking the focus.
  const area = screen.getPrimaryDisplay().workArea;
  const pet = new BrowserWindow({ x: area.x + area.width - 180, y: area.y + area.height - 180, width: 160, height: 160, frame: false, alwaysOnTop: true, focusable: false, skipTaskbar: true, show: false, backgroundColor: "#e11d48" });
  pet.setAlwaysOnTop(true, "floating");
  await pet.loadURL("data:text/html,<body style='background:%23e11d48'></body>");
  pet.showInactive();
  await new Promise((resolve) => setTimeout(resolve, 600));

  for (const round of ["first", "again"]) {
    const took = Date.now();
    const shot = await capture([pet], { x: area.x + area.width - 100, y: area.y + area.height - 100 }).catch((error) => ({ threw: String(error) }));
    report[round] = {
      ms: Date.now() - took,
      ...(shot.threw ? { threw: shot.threw } : {}),
      ...(shot.error ? { error: shot.error } : {}),
      ...(shot.needs ? { needs: shot.needs } : {}),
      ...("frontListed" in shot ? { frontListed: shot.frontListed } : {}),
      ...(shot.window ? { window: { id: shot.window.id, bytes: bytes(shot.window), isTheStandIn: shot.window.id === pet.getMediaSourceId() } } : {}),
      ...(shot.screen ? { screen: { bytes: bytes(shot.screen) } } : {}),
      standInOpacityAfter: pet.getOpacity(),
    };
    // Only on a throwaway machine (CI) is the window's title kept: elsewhere it is the owner's.
    if (process.env.CI && shot.window) report[round].window.name = shot.window.name;
  }
  pet.destroy();
  report.done = true;
  write();
  // A moment more, for the check to see which app macOS holds responsible for this one.
  setTimeout(() => app.quit(), 3_000);
});
