/**
 * Talking to Perry: speech to text on this computer (whisper.js, in this
 * process), and the hotkey.
 *
 * The hotkey (Ctrl+Shift+Space, Cmd+Shift+Space on a Mac) works from
 * anywhere. Tap it to start listening and tap again to send; or hold it while
 * you speak and let go to send. Esc cancels. Holding needs to hear the key
 * come up, which Electron's shortcuts cannot: uiohook-napi does, where it
 * can run (on a Mac only once Perry has Accessibility permission); without
 * it, tapping still works, and the pet and Settings say so.
 */

import { app, clipboard, globalShortcut, systemPreferences } from "electron";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";

export { transcribe, warmUp } from "./whisper.js";

const require = createRequire(import.meta.url);
/** Held longer than this, letting go sends; a shorter press is a tap. */
const HOLD_MS = 400;
/** Presses closer together than this are the key repeating while held, not new presses (where the key hook cannot hear them). */
const REPEAT_MS = 600;
/** The key hook and Electron's shortcut report the same press, either first, within this of each other. */
const HEAR_MS = 250;
/** Pasting waits this long at most for the keys of its own shortcut to come up, or the app would see those instead. */
const PASTE_WAITS_MS = 1_500;
/** The clipboard is put back this long after pasting, once the app has read it. */
const PASTE_RESTORE_MS = 600;

/** As convex/lib/shortcuts.ts has it, until the dashboard says otherwise. */
export const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";

/** Electron's name for a key, as uiohook names it, for hearing it go down and come up. */
const HOOK_NAMES = {
  Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight", Return: "Enter", Esc: "Escape", Plus: "Equal",
  ";": "Semicolon", "=": "Equal", ",": "Comma", "-": "Minus", ".": "Period", "/": "Slash", "`": "Backquote",
  "[": "BracketLeft", "\\": "Backslash", "]": "BracketRight", "'": "Quote",
};
// Electron takes "a" for A; uiohook has only the capital.
const hookName = (name) => HOOK_NAMES[name] ?? (name.length === 1 ? name.toUpperCase() : name);

/**
 * For the end-to-end check (artifacts/hold-to-talk), which must never press
 * the owner's real keys: with PERRY_PET_FAKE_KEYS set, the key hook and Esc
 * are stand-ins the check works from inside this process
 * (globalThis.perryFakeKeys), where it can press the hotkey too. Set to
 * "off", there is no hook, as on a computer where it cannot run. Never set
 * otherwise.
 */
const FAKE_KEYS = process.env.PERRY_PET_FAKE_KEYS;
function fakeKeys() {
  const { UiohookKey } = require("uiohook-napi");
  const uIOhook = Object.assign(new EventEmitter(), { start() {}, stop() {} });
  const event = (name) => ({ keycode: UiohookKey[hookName(name)] });
  const controls = globalThis.perryFakeKeys = {
    shortcut: () => {}, escape: () => {},
    down: (name) => uIOhook.emit("keydown", event(name)),
    up: (name) => uIOhook.emit("keyup", event(name)),
  };
  return { hook: { uIOhook, UiohookKey }, controls };
}

/**
 * The hotkey. `send(type)` tells the page what to do: start listening, stop
 * and send, or cancel. Returns what the hotkey can be asked:
 *   change(accelerator)  move to other keys (Settings → Desktop pet → Keyboard shortcuts);
 *                        { hotkey } once it has them, or { error: "taken" }
 *                        when another app has them ("invalid" when they are
 *                        not keys at all), keeping the ones it had
 *   current()            the keys it is on, or null when it has none
 *   hold()               null while holding works; otherwise why only
 *                        tapping does: "access" (a Mac, until Perry has
 *                        Accessibility) or "off" (the key hook cannot run)
 *   start()              start listening, as a tap does (his tray menu)
 *   done()               the page stopped listening on its own (its stop
 *                        button), so the next press starts again
 *
 * Electron's shortcut says the keys went down, never that they came up, and
 * may say it again and again while they are held, as the keyboard repeats.
 * So where the key
 * hook runs, it has the last word: a press of the hotkey's last key that it
 * heard go down is one press however long it is held, and that key coming up
 * after a hold sends, whatever was let go of before it. The hook and the
 * shortcut report the same press in their own time, either first. A press
 * the hook did not hear at all (on Windows, while an app run as
 * administrator is in front, whose keys it cannot see) is a tap.
 */
export function hotkeys(send) {
  let hotkey = null;
  let listening = false;
  let pressedAt = 0;
  /** Whether the press that started listening is still down: its key coming up, after a hold, sends. */
  let holding = false;
  /** Why holding does not work, or null (hold() above); the hook's names for keys, once it runs; the hotkey's last key, by that name. */
  let hold = null;
  let names = null;
  let key = null;
  /** The last press of that key the hook heard: whether it is still down, when it was last heard, when it came up, whether it was the hotkey. */
  let stroke = null;
  /** The shortcut, fired before the hook heard its key go down: waiting a moment for it to. */
  let waiting = null;
  let lastUnheard = 0;
  /** Whether a modifier was down at the last key event, so pasting can wait for its shortcut to be let go. */
  let modifiersDown = false;
  let hookApi = null;
  const fake = FAKE_KEYS ? fakeKeys() : null;
  const escape = fake
    ? { on: (cancel) => { fake.controls.escape = cancel; }, off: () => { fake.controls.escape = () => {}; } }
    : { on: (cancel) => globalShortcut.register("Escape", cancel), off: () => globalShortcut.unregister("Escape") };

  const cancel = () => { if (listening) finish("cancel"); };
  const finish = (type) => {
    listening = false;
    holding = false;
    // A press still waiting to be heard would start listening again after this.
    clearTimeout(waiting);
    waiting = null;
    escape.off();
    send(type);
  };
  const begin = (held) => {
    listening = true;
    pressedAt = Date.now();
    holding = held;
    // Esc is Perry's while he listens, and everyone's again after.
    escape.on(cancel);
    send("start");
  };
  /** One press of the hotkey: it starts listening, or, listening, sends. */
  const press = () => (listening ? finish("stop") : begin(true));
  /** A press the hook did not hear, which only the shortcut reports, again and again while it is held. */
  const unheard = (at) => {
    const repeat = at - lastUnheard < REPEAT_MS;
    lastUnheard = at;
    if (!repeat) press();
  };
  const use = () => {
    stroke.used = true;
    press();
  };

  const keyDown = (event) => {
    if (key === null || event.keycode !== key) return;
    const now = Date.now();
    if (!stroke?.down) {
      stroke = { down: true, heardAt: now, upAt: 0, used: false };
      // Down again, the press that started listening is over, heard coming up or not.
      holding = false;
    }
    stroke.heardAt = now;
    // The shortcut came first; this is its key.
    if (waiting) {
      clearTimeout(waiting);
      waiting = null;
      if (!stroke.used) use();
    }
  };
  const keyUp = (event) => {
    if (key === null || event.keycode !== key) return;
    if (stroke) Object.assign(stroke, { down: false, upAt: Date.now() });
    if (!holding) return;
    holding = false;
    if (listening && Date.now() - pressedAt >= HOLD_MS) finish("stop");
  };
  const shortcut = () => {
    const now = Date.now();
    if (hold === "access") startHook();
    if (!names || key === null) return unheard(now);
    // Heard going down a moment ago, the usual order; already used, it is the key repeating.
    if (stroke?.down && now - stroke.heardAt < HEAR_MS) {
      if (!stroke.used) use();
      return;
    }
    if (waiting) return;
    waiting = setTimeout(() => {
      waiting = null;
      // The key repeating, reported after it came up.
      if (stroke?.used && !stroke.down && now - stroke.upAt < HEAR_MS) return;
      // Not heard at all; and whatever the hook thought was still down came up unheard too.
      if (stroke) stroke.down = false;
      unheard(now);
    }, HEAR_MS);
  };
  if (fake) fake.controls.shortcut = shortcut;

  /** The key hook, where it can run: on a Mac only once Perry has Accessibility, which each press asks again until he does. */
  function startHook() {
    if (process.platform === "darwin" && !fake && !systemPreferences.isTrustedAccessibilityClient(false)) {
      hold = "access";
      return;
    }
    try {
      if (FAKE_KEYS === "off") throw new Error("there is no key hook (PERRY_PET_FAKE_KEYS=off)");
      const { uIOhook, UiohookKey } = fake?.hook ?? require("uiohook-napi");
      const watch = (event) => { modifiersDown = Boolean(event.ctrlKey || event.altKey || event.shiftKey || event.metaKey); };
      uIOhook.on("keydown", watch);
      uIOhook.on("keyup", watch);
      uIOhook.on("keydown", keyDown);
      uIOhook.on("keyup", keyUp);
      hookApi = { uIOhook, UiohookKey };
      uIOhook.start();
      app.on("will-quit", () => uIOhook.stop());
      names = UiohookKey;
      hold = null;
      if (hotkey) key = names[hookName(hotkey.split("+").pop())] ?? null;
    } catch (error) {
      hold = "off";
      console.error(`hold to talk is off (tap the hotkey instead): ${error}`);
    }
  }
  startHook();

  const change = (accelerator) => {
    if (accelerator === hotkey) return { hotkey };
    let taken;
    try {
      taken = globalShortcut.register(accelerator, shortcut);
    } catch {
      return { error: "invalid" };
    }
    if (!taken) return { error: "taken" };
    if (hotkey) globalShortcut.unregister(hotkey);
    hotkey = accelerator;
    key = names?.[hookName(accelerator.split("+").pop())] ?? null;
    stroke = null;
    clearTimeout(waiting);
    waiting = null;
    return { hotkey };
  };
  const done = () => {
    listening = false;
    holding = false;
    clearTimeout(waiting);
    waiting = null;
    escape.off();
  };
  /** Put text into whatever app has the keyboard: "pasted", or "copied" where keys cannot be pressed for the owner. */
  const paste = async (text) => {
    // The end-to-end check must not touch the owner's clipboard.
    if (fake) return "copied";
    const before = clipboard.readText();
    const image = clipboard.availableFormats().some((format) => format.startsWith("image/")) ? clipboard.readImage() : null;
    clipboard.writeText(text);
    if (!hookApi) return "copied";
    for (const until = Date.now() + PASTE_WAITS_MS; modifiersDown && Date.now() < until;) await new Promise((resolve) => setTimeout(resolve, 25));
    const { uIOhook, UiohookKey } = hookApi;
    uIOhook.keyTap(UiohookKey.V, [process.platform === "darwin" ? UiohookKey.Meta : UiohookKey.Ctrl]);
    setTimeout(() => {
      if (clipboard.readText() !== text) return;
      if (image) clipboard.writeImage(image);
      else clipboard.writeText(before);
    }, PASTE_RESTORE_MS);
    return "pasted";
  };
  return {
    change, done, paste,
    current: () => hotkey,
    // A key the hook has no name for cannot be heard coming up either.
    hold: () => hold ?? (hotkey && key === null ? "off" : null),
    start: () => { if (!listening) begin(false); },
  };
}
