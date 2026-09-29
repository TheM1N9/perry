/**
 * Looking at the screen (issue #101): a picture of the window the owner is
 * in, and of the whole screen, for a question about what is open ("what's
 * this error?", "reply to this"). Taken only when they ask, with his Look
 * hotkey or the button in his chat, and shown to them before anything is sent.
 *
 * Which window: the one in front, which is the one they were in when they
 * pressed the hotkey. On Windows that comes from user32, through PowerShell;
 * on a Mac from AppKit and the window list (the app in front, and its window
 * nearest the top), through osascript. When the one in front is his own (they
 * clicked his button), the topmost window that is not his: on a Mac the next
 * in that same list, front to back; elsewhere the first in desktopCapturer's
 * list (also front to back) that does not let clicks through, as an overlay
 * does.
 *
 * On a Mac, macOS must allow the app his window runs in (Electron, from
 * pet/node_modules) to record the screen. Until it does, Electron's
 * desktopCapturer fails outright ("Failed to get sources."); the first time,
 * that same call is what has macOS ask the owner. An app is allowed as it
 * starts, so he must start again once they have said yes.
 */

import { spawn } from "node:child_process";
import { desktopCapturer, globalShortcut, screen, systemPreferences } from "electron";

/** The longest side of a picture, in pixels: sharp enough to read, small enough to send. */
const LONGEST = 2560;
const USER32 = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PerryLook { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i); }'\n`;
/** GetWindowLong's extended styles, and the one a window that lets clicks through has. */
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20;
/**
 * On a Mac, the app in front and the ordinary windows on screen (layer 0: not
 * the menu bar, the Dock or anything floating, as he does), front to back,
 * leaving out his own (argv[0], his process). Neither needs any permission;
 * only windows' titles would. JavaScript for osascript, which prints what
 * run returns.
 */
const APPKIT = `ObjC.import("AppKit");
ObjC.import("CoreGraphics");
function run(argv) {
  const own = Number(argv[0]);
  const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  const pid = app.isNil() ? 0 : app.processIdentifier;
  // kCGWindowListOptionOnScreenOnly | kCGWindowListExcludeDesktopElements, and every window (kCGNullWindowID).
  const listed = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  const windows = listed.filter((w) => w.kCGWindowLayer === 0 && w.kCGWindowOwnerPID !== own);
  const front = windows.find((w) => w.kCGWindowOwnerPID === pid);
  return JSON.stringify({ front: front ? front.kCGWindowNumber : null, app: front ? front.kCGWindowOwnerName : null, order: windows.map((w) => w.kCGWindowNumber) });
}`;

/**
 * The app macOS asks about and lists under Screen Recording: the .app his
 * window runs in, Electron's own (pet/node_modules/electron). It keeps its
 * name and its signature from one version to the next, so what the owner
 * allowed stays allowed after `perry update`.
 */
export const MAC_APP = process.execPath.match(/([^/]+)\.app\/Contents\/MacOS\//)?.[1] ?? "Electron";
/** System Settings, open where the owner allows it. */
export const SCREEN_RECORDING_SETTINGS = "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture";
/** What the owner (and Perry, when he asked to look) is told while macOS does not let him see the screen. */
const NOT_ALLOWED = `Perry can't see the screen yet: macOS has to allow it. In System Settings → Privacy & Security → Screen & System Audio Recording (Screen Recording before macOS 15), turn on “${MAC_APP}”, the app the desktop pet runs in. Then restart the pet: Restart, in his tray icon's menu. If macOS offers to Quit & Reopen, choose Later: that would open ${MAC_APP} without him.`;

/**
 * Which window is in front, asked as the picture is taken: `ask` answers.
 * On Windows, PowerShell starts (and compiles its user32 calls) meanwhile,
 * and also says which of some windows let clicks through; `ask` takes their
 * handles, and answers { front, through }. On a Mac osascript answers at
 * once, before his own window can come to the front: { front, app, order }.
 * Null elsewhere, or when it fails.
 */
export function inFront() {
  if (process.platform === "darwin") return appKit();
  if (process.platform !== "win32") return { ask: async () => null };
  const shell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  const answer = answerOf(shell);
  shell.stdin.on("error", () => {});
  shell.stdin.write(USER32);
  return {
    ask: async (windows) => {
      const list = windows.filter(Number.isFinite).join(",");
      shell.stdin.end(`$t = @(@(${list}) | Where-Object { ([PerryLook]::GetWindowLong([IntPtr][long]$_, ${GWL_EXSTYLE}) -band ${WS_EX_TRANSPARENT}) -ne 0 }); ConvertTo-Json -Compress @{ front = [PerryLook]::GetForegroundWindow().ToInt64(); through = @($t) }\n`);
      return await answer();
    },
  };
}

function appKit() {
  const script = spawn("osascript", ["-l", "JavaScript", "-e", APPKIT, String(process.pid)], { stdio: ["ignore", "pipe", "ignore"] });
  return { ask: answerOf(script) };
}

/** What a helper prints, as the JSON line in it, once it ends: given five seconds from when it is asked for, then null. */
function answerOf(child) {
  let out = "";
  child.stdout.on("data", (chunk) => { out += chunk; });
  const ended = new Promise((resolve) => { child.on("close", resolve); child.on("error", resolve); });
  return async () => {
    const timer = setTimeout(() => child.kill(), 5_000);
    await ended;
    clearTimeout(timer);
    try {
      return JSON.parse(out.split(/\r?\n/).find((line) => line.trim().startsWith("{")) ?? "null");
    } catch {
      return null;
    }
  };
}

/** A window's handle (its CGWindowID on a Mac), from desktopCapturer's id for it ("window:<handle>:0"). */
const handleOf = (source) => Number(source.id.split(":")[1]);

/**
 * The window the owner was in (none when there is none to see) and the screen
 * nearest `near`, as PNG data URLs. Perry's own windows (`own`) are never in
 * the picture: left out of the windows, and see-through for the screen.
 *
 * On a Mac that has not allowed it, only { error, needs: "screen-recording" }:
 * the first time, macOS has asked the owner by then.
 */
export async function capture(own, near) {
  if (process.platform === "darwin" && systemPreferences.getMediaAccessStatus("screen") !== "granted") {
    // Asking for the pictures is what has macOS ask, the first time; after that it only fails, at once.
    await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } }).catch(() => {});
    return { error: NOT_ALLOWED, needs: "screen-recording" };
  }
  const asking = inFront();
  const display = screen.getDisplayNearestPoint(near);
  const width = display.size.width * display.scaleFactor;
  const height = display.size.height * display.scaleFactor;
  const scale = Math.min(1, LONGEST / Math.max(width, height));
  const mine = new Set(own.filter((win) => win && !win.isDestroyed()).map((win) => win.getMediaSourceId()));
  const hidden = own.filter((win) => win && !win.isDestroyed() && win.isVisible());
  // See-through rather than hidden: hiding would take the focus, and his panel closes when it loses it.
  for (const win of hidden) win.setOpacity(0);
  let sources;
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    sources = await desktopCapturer.getSources({ types: ["window", "screen"], thumbnailSize: { width: Math.round(width * scale), height: Math.round(height * scale) } });
  } catch (error) {
    return { error: `Perry couldn't take a picture of the screen (${error instanceof Error ? error.message : String(error)})` };
  } finally {
    for (const win of hidden) if (!win.isDestroyed()) win.setOpacity(1);
  }
  const windows = sources.filter((source) => source.id.startsWith("window:") && !mine.has(source.id) && !source.thumbnail.isEmpty());
  const named = windows.filter((source) => source.name);
  const facts = await asking.ask(named.map(handleOf));
  const byHandle = (handle) => named.find((source) => handleOf(source) === handle);
  // A Mac window in front may have no title (the window list names its app); elsewhere one without is not a window to show.
  const front = windows.find((source) => handleOf(source) === facts?.front && (source.name || facts.app));
  const top = front
    ?? facts?.order?.map(byHandle).find(Boolean)
    ?? named.find((source) => !facts?.through?.includes(handleOf(source)));
  const screens = sources.filter((source) => source.id.startsWith("screen:") && !source.thumbnail.isEmpty());
  const whole = screens.find((source) => source.display_id === String(display.id)) ?? screens[0];
  if (!top && !whole) return { error: "Perry couldn't take a picture of the screen." };
  return {
    // Whether the window in front could be pictured at all: some cannot (Windows' own search panel, for one), and then the topmost other one is.
    ...(facts ? { frontListed: Boolean(front) } : {}),
    ...(top ? { window: { id: top.id, name: top.name || facts?.app || "Window", image: top.thumbnail.toDataURL() } } : {}),
    ...(whole ? { screen: { name: screens.length > 1 ? whole.name : "Whole screen", image: whole.thumbnail.toDataURL() } } : {}),
  };
}

/**
 * The Look hotkey. `press` takes the picture. `change(accelerator)` moves it
 * to other keys: { hotkey } once it has them, or { error: "taken" } when
 * another app has them ("invalid" when they are not keys), keeping the old.
 */
export function lookKey(press) {
  let hotkey = null;
  const change = (accelerator) => {
    if (accelerator === hotkey) return { hotkey };
    let taken;
    try {
      taken = globalShortcut.register(accelerator, press);
    } catch {
      return { error: "invalid" };
    }
    if (!taken) return { error: "taken" };
    if (hotkey) globalShortcut.unregister(hotkey);
    hotkey = accelerator;
    return { hotkey };
  };
  return { change, current: () => hotkey };
}
