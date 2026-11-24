import { spawn } from "node:child_process";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

const [modelsDir, language, model, output] = process.argv.slice(2);
let decoder;
process.on("disconnect", () => { decoder?.kill(); process.exit(1); });
process.once("message", async ({ audio }) => {
  try {
    const samples = await new Promise((done, fail) => {
      const ffmpeg = spawn(process.env.PERRY_FFMPEG ?? "ffmpeg", ["-v", "error", "-i", "pipe:0", "-t", "601", "-ac", "1", "-ar", "16000", "-f", "f32le", "pipe:1"], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
      decoder = ffmpeg;
      const chunks = [];
      let size = 0;
      ffmpeg.once("error", () => fail(new Error("Local voice transcription needs ffmpeg on this computer.")));
      ffmpeg.stdout.on("data", chunk => {
        size += chunk.length;
        if (size > 600 * 16000 * 4) { ffmpeg.kill(); fail(new Error("Automatic voice transcription is limited to ten minutes; the original audio remains attached.")); }
        else chunks.push(chunk);
      });
      ffmpeg.stdin.on("error", () => {});
      ffmpeg.once("close", code => {
        if (code !== 0) return fail(new Error("The voice note could not be decoded for local transcription."));
        const pcm = Buffer.concat(chunks);
        if (!pcm.length || pcm.length % 4) return fail(new Error("The voice note contains no decodable speech."));
        done(new Float32Array(pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength)));
      });
      ffmpeg.stdin.end(Buffer.from(audio, "base64"));
    });
    const { env } = await import("@huggingface/transformers");
    env.allowRemoteModels = false;
    const { transcribe } = await import("../pet/whisper.js");
    const text = await transcribe(modelsDir, samples, undefined, { language, model });
    await mkdir(dirname(output), { recursive: true });
    await writeFile(`${output}.tmp`, JSON.stringify({ text }));
    await rename(`${output}.tmp`, output);
    process.send?.({ text }, () => process.exit(0));
  } catch (error) {
    const message = error instanceof Error && /voice|ffmpeg|ten minutes|decode/.test(error.message) ? error.message : "The local Whisper model is unavailable. Download it through Desktop pet speech settings; the original voice note remains attached.";
    process.send?.({ error: message }, () => process.exit(1));
  }
});
