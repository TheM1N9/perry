/**
 * Looking at the screen (issue #101): a picture of the window the owner is
 * in, and of the whole screen, for a question about what is open ("what's
 * this error?", "reply to this"). Taken only when they ask, with his Look
 * hotkey or the button in his chat, and shown to them before anything is sent.
 *
 * Which window: on Windows, the one in front (from user32, through
 * PowerShell), which is the one they were in when they pressed the hotkey.
 * Otherwise, and when the one in front is his own (they clicked his button),
 * the topmost window that is not his and does not let clicks through, as an
 * overlay does; Electron's desktopCapturer lists windows front to back. On a
 * Mac it needs Screen Recording permission; without it, the pictures come
 * back empty.
 */

import { spawn } from "node:child_process";
import { desktopCapturer, globalShortcut, screen } from "electron";

/** The longest side of a picture, in pixels: sharp enough to read, small enough to send. */
const LONGEST = 2560;
const USER32 = `Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class PerryLook { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int i); }'\n`;
/** GetWindowLong's extended styles, and the one a window that lets clicks through has. */
const GWL_EXSTYLE = -20;
const WS_EX_TRANSPARENT = 0x20;

/**
 * On Windows, which window is in front, and which of some windows let clicks
 * through. PowerShell starts (and compiles its user32 calls) while the
 * picture is taken, then `ask` answers; null elsewhere, or when it fails.
 */
function user32() {
  if (process.platform !== "win32") return { ask: async () => null };
  const shell = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "-"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
  let out = "";
  shell.stdout.on("data", (chunk) => { out += chunk; });
  shell.stdin.on("error", () => {});
  const ended = new Promise((resolve) => { shell.on("close", resolve); shell.on("error", resolve); });
  shell.stdin.write(USER32);
  return {
    /** `windows` are window handles; the answer is { front, through } in handles. */
    ask: async (windows) => {
      const list = windows.filter(Number.isFinite).join(",");
      shell.stdin.end(`$t = @(@(${list}) | Where-Object { ([PerryLook]::GetWindowLong([IntPtr][long]$_, ${GWL_EXSTYLE}) -band ${WS_EX_TRANSPARENT}) -ne 0 }); ConvertTo-Json -Compress @{ front = [PerryLook]::GetForegroundWindow().ToInt64(); through = @($t) }\n`);
      const timer = setTimeout(() => shell.kill(), 5_000);
      await ended;
      clearTimeout(timer);
      try {
        return JSON.parse(out.split(/\r?\n/).find((line) => line.trim().startsWith("{")) ?? "null");
      } catch {
        return null;
      }
    },
  };
}

/** A window's handle, from desktopCapturer's id for it ("window:<handle>:0"). */
const handleOf = (source) => Number(source.id.split(":")[1]);

/**
 * The window the owner was in (none when there is none to see) and the screen
 * nearest `near`, as PNG data URLs. Perry's own windows (`own`) are never in
 * the picture: left out of the windows, and see-through for the screen.
 */
export async function capture(own, near) {
  const asking = user32();
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
  } finally {
    for (const win of hidden) if (!win.isDestroyed()) win.setOpacity(1);
  }
  const windows = sources.filter((source) => source.id.startsWith("window:") && !mine.has(source.id) && source.name && !source.thumbnail.isEmpty());
  const facts = await asking.ask(windows.map(handleOf));
  const top = windows.find((source) => handleOf(source) === facts?.front)
    ?? windows.find((source) => !facts?.through?.includes(handleOf(source)));
  const screens = sources.filter((source) => source.id.startsWith("screen:") && !source.thumbnail.isEmpty());
  const whole = screens.find((source) => source.display_id === String(display.id)) ?? screens[0];
  if (!top && !whole) {
    return { error: process.platform === "darwin"
      ? "Perry can't see the screen yet. Allow him in System Settings → Privacy & Security → Screen Recording, then try again."
      : "Perry couldn't take a picture of the screen." };
  }
  return {
    ...(top ? { window: { id: top.id, name: top.name, image: top.thumbnail.toDataURL() } } : {}),
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
