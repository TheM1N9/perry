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
 * it, tapping still works.
 */

import { app, globalShortcut, systemPreferences } from "electron";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const MODEL = process.env.PERRY_VOICE_MODEL ?? "onnx-community/whisper-base";
/** Whisper guesses English when not told; set this to speak another language ("spanish", "hindi"). */
const LANGUAGE = process.env.PERRY_VOICE_LANGUAGE ?? "english";
/** Held longer than this, letting go sends; a shorter press is a tap. */
const HOLD_MS = 400;
/** Presses closer together than this are the key repeating while held, not new presses. */
const REPEAT_MS = 600;

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

/** Electron's name for a key, as uiohook names it, for hearing it come up. */
const HOOK_NAMES = {
  Up: "ArrowUp", Down: "ArrowDown", Left: "ArrowLeft", Right: "ArrowRight",
  ";": "Semicolon", "=": "Equal", ",": "Comma", "-": "Minus", ".": "Period", "/": "Slash", "`": "Backquote",
  "[": "BracketLeft", "\\": "Backslash", "]": "BracketRight", "'": "Quote",
};

/**
 * The hotkey. `send(type)` tells the page what to do: start listening, stop
 * and send, or cancel. Returns what the hotkey can be asked:
 *   change(accelerator)  move to other keys (Settings → Keyboard shortcuts);
 *                        { hotkey } once it has them, or { error: "taken" }
 *                        when another app has them ("invalid" when they are
 *                        not keys at all), keeping the ones it had
 *   current()            the keys it is on, or null when it has none
 *   done()               the page stopped listening on its own (its stop
 *                        button), so the next press starts again
 */
export function hotkeys(send) {
  let hotkey = null;
  let listening = false;
  let pressedAt = 0;
  let lastEvent = 0;
  /** Where the key can be heard coming up: whether this press was already acted on. */
  let hook = null;
  let key = null;
  let handled = false;
  const cancel = () => { if (listening) finish("cancel"); };
  const finish = (type) => {
    listening = false;
    globalShortcut.unregister("Escape");
    send(type);
  };
  const press = () => {
    // A key held down repeats; only its first press counts.
    if (key !== null) {
      if (handled) return;
      handled = true;
    } else {
      const repeat = Date.now() - lastEvent < REPEAT_MS;
      lastEvent = Date.now();
      if (repeat) return;
    }
    if (listening) return finish("stop");
    listening = true;
    pressedAt = Date.now();
    // Esc is Perry's while he listens, and everyone's again after.
    globalShortcut.register("Escape", cancel);
    send("start");
  };

  // Hold to talk: the hotkey's last key coming up, after a hold, sends.
  const trusted = process.platform !== "darwin" || systemPreferences.isTrustedAccessibilityClient(false);
  if (trusted) {
    try {
      const { uIOhook, UiohookKey } = require("uiohook-napi");
      hook = UiohookKey;
      uIOhook.on("keyup", (event) => {
        if (key === null || event.keycode !== key) return;
        handled = false;
        if (listening && Date.now() - pressedAt >= HOLD_MS) finish("stop");
      });
      uIOhook.start();
      app.on("will-quit", () => uIOhook.stop());
    } catch (error) {
      hook = null;
      console.error(`hold to talk is off (tap the hotkey instead): ${error}`);
    }
  }

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
    const last = accelerator.split("+").pop();
    key = hook?.[HOOK_NAMES[last] ?? last] ?? null;
    handled = false;
    return { hotkey };
  };
  const done = () => {
    listening = false;
    globalShortcut.unregister("Escape");
  };
  return { change, current: () => hotkey, done };
}
