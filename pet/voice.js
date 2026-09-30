/**
 * Talking to Perry: speech to text on this computer, and the hotkey.
 *
 * Speech becomes text with Whisper (base, 8-bit, about 80 MB), run by
 * transformers.js on ONNX Runtime in this process. The model is downloaded
 * from Hugging Face the first time and kept in ~/.perry/models; after that,
 * nothing leaves the computer. Adapted from how OpenWhispr (MIT) does it,
 * with a library in place of its native whisper.cpp server.
 *
 * The hotkey (Ctrl+Shift+Space, Cmd+Shift+Space on a Mac) works from
 * anywhere. Tap it to start listening and tap again to send; or hold it while
 * you speak and let go to send. Esc cancels. Holding needs to hear the key
 * come up, which Electron's shortcuts cannot: uiohook-napi does, where it
 * can run (on a Mac only once Perry has Accessibility permission); without
 * it, tapping still works, and the pet and Settings say so.
 */

import { app, globalShortcut, systemPreferences } from "electron";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const MODEL = process.env.PERRY_VOICE_MODEL ?? "onnx-community/whisper-base";
/** Whisper guesses English when not told; set this to speak another language ("spanish", "hindi"). */
const LANGUAGE = process.env.PERRY_VOICE_LANGUAGE ?? "english";
/** Held longer than this, letting go sends; a shorter press is a tap. */
const HOLD_MS = 400;
/** Presses closer together than this are the key repeating while held, not new presses (where the key hook cannot hear them). */
const REPEAT_MS = 600;
/** The key hook and Electron's shortcut report the same press, either first, within this of each other. */
const HEAR_MS = 250;

/** As convex/lib/shortcuts.ts has it, until the dashboard says otherwise. */
export const DEFAULT_HOTKEY = "CommandOrControl+Shift+Space";

let recognizer = null;

/** Whisper, loaded once; `progress` hears how the first download goes. */
function load(modelsDir, progress) {
  recognizer ??= (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = modelsDir;
    return await pipeline("automatic-speech-recognition", MODEL, {
      dtype: "q8",
      progress_callback: (event) => {
        if (event.status === "progress" && event.total) progress?.({ file: event.file, loaded: event.loaded, total: event.total });
      },
    });
  })().catch((error) => {
    recognizer = null;
    throw error;
  });
  return recognizer;
}

/** Load it in the background when it is already downloaded, so the first words need not wait. */
export function warmUp(modelsDir) {
  if (existsSync(join(modelsDir, ...MODEL.split("/")))) void load(modelsDir).catch(() => {});
}

/** 16 kHz mono samples in, what was said out. */
export async function transcribe(modelsDir, samples, progress) {
  const whisper = await load(modelsDir, progress);
  const { text } = await whisper(samples, { language: LANGUAGE, task: "transcribe" });
  // Whisper names silence and noise rather than leaving them out.
  return text.replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]|\((silence|music|noise)\)/gi, "").trim();
}

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
 *   change(accelerator)  move to other keys (Settings → Keyboard shortcuts);
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
  const fake = FAKE_KEYS ? fakeKeys() : null;
  const escape = fake
    ? { on: (cancel) => { fake.controls.escape = cancel; }, off: () => { fake.controls.escape = () => {}; } }
    : { on: (cancel) => globalShortcut.register("Escape", cancel), off: () => globalShortcut.unregister("Escape") };

  const cancel = () => { if (listening) finish("cancel"); };
  const finish = (type) => {
    listening = false;
    holding = false;
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
      uIOhook.on("keydown", keyDown);
      uIOhook.on("keyup", keyUp);
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
    escape.off();
  };
  return {
    change, done,
    current: () => hotkey,
    // A key the hook has no name for cannot be heard coming up either.
    hold: () => hold ?? (hotkey && key === null ? "off" : null),
    start: () => { if (!listening) begin(false); },
  };
}
