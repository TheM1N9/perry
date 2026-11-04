/**
 * Writing down a call, in a process of its own (listen.js forks it). Whisper
 * holds the process it runs in for a second or more at a time, and for a call
 * that is hours of it: in his window's process that would drop the mouse hook
 * on Windows (main.js, applyMouse) and stall his tray. It goes when listening
 * ends, and the model's memory with it.
 *
 * One chunk at a time, as listen.js sends them: what was heard, by whom, and
 * it answers with the words.
 */

import { transcribe } from "./whisper.js";

const [modelsDir, language = "en", model = "small"] = process.argv.slice(2);

process.parentPort.on("message", async ({ data }) => {
  const started = Date.now();
  try {
    const text = await transcribe(modelsDir, data.samples, (progress) => process.parentPort.postMessage({ type: "progress", ...progress }), { language, model: process.env.PERRY_VOICE_MODEL ?? `onnx-community/whisper-${model}` });
    process.parentPort.postMessage({ type: "done", seq: data.seq, text, ms: Date.now() - started });
  } catch (error) {
    process.parentPort.postMessage({ type: "failed", seq: data.seq, error: error instanceof Error ? error.message : String(error) });
  }
});
