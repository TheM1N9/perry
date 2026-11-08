/**
 * Speech to text on this computer: multilingual Whisper Small, run by
 * transformers.js on ONNX Runtime in whichever process asks. The model is
 * downloaded from Hugging Face the first time and kept in ~/.perry/models;
 * after that, nothing leaves the computer. Adapted from how OpenWhispr (MIT)
 * does it, with a library in place of its native whisper.cpp server.
 *
 * Talking to him (voice.js) runs it in his window's own process; listening to
 * a call (listen-worker.js) in a process of its own, for hours at a time.
 */

const MODEL = process.env.PERRY_VOICE_MODEL ?? "onnx-community/whisper-small";
/** Whisper guesses English when not told; set this to speak another language ("spanish", "hindi"). */
const LANGUAGE = process.env.PERRY_VOICE_LANGUAGE ?? "english";

let recognizer = null;
/** Who hears how the download goes: whoever is waiting for it now, even if it began without them. */
let listening = null;

/** Whisper, loaded once; `progress` hears how the first download goes. */
function load(modelsDir, progress, model = MODEL) {
  if (progress) listening = progress;
  recognizer ??= (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = modelsDir;
    return await pipeline("automatic-speech-recognition", model, {
      dtype: "q8",
      device: process.env.PERRY_VOICE_DEVICE ?? "cpu",
      progress_callback: (event) => {
        if (event.status === "progress" && event.total) listening?.({ file: event.file, loaded: event.loaded, total: event.total });
      },
    });
  })().catch((error) => {
    recognizer = null;
    throw error;
  });
  return recognizer;
}

/** Load it in the background, downloading it the first time, so the first words need not wait for either. */
export function warmUp(modelsDir) {
  void load(modelsDir).catch(() => {});
}

/** 16 kHz mono samples in, what was said out. */
export async function transcribe(modelsDir, samples, progress, options = {}) {
  const whisper = await load(modelsDir, progress, options.model ?? MODEL);
  listening = null;
  const { text } = await whisper(samples, { language: options.language ?? LANGUAGE, task: "transcribe" });
  // Whisper names silence and noise rather than leaving them out.
  return text.replace(/\[(BLANK_AUDIO|MUSIC|NOISE|SILENCE)\]|\((silence|music|noise)\)/gi, "").trim();
}
