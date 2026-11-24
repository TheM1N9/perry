import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { HOME } from "../runner/home";
import { killTree } from "../lib/kill-tree";

export async function transcribeWhatsAppVoice(audio: Buffer, signal: AbortSignal, options: { language: string; model: string }): Promise<string> {
  signal.throwIfAborted();
  if (audio.length > 25 * 1024 * 1024) throw new Error("Automatic voice transcription is limited to 25 MB; the original audio remains attached.");
  const cache = join(HOME, "whatsapp", "transcripts");
  await mkdir(cache, { recursive: true });
  const key = createHash("sha256").update(JSON.stringify(options)).update(audio).digest("hex");
  const output = join(cache, `${key}.json`);
  try {
    const saved = JSON.parse(await readFile(output, "utf8"));
    if (typeof saved.text !== "string") throw new Error("Saved voice transcript is damaged.");
    return saved.text;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const files: Array<{ path: string; at: number }> = [];
  for (const name of await readdir(cache)) if (/^[a-f0-9]{64}\.json(?:\.tmp)?$/.test(name)) {
    try { files.push({ path: join(cache, name), at: (await stat(join(cache, name))).mtimeMs }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  for (const [index, file] of files.sort((a, b) => b.at - a.at).entries()) if (index >= 255 || file.at < Date.now() - 7 * 86400_000) await unlink(file.path);
  return await new Promise<string>((done, fail) => {
    const child = fork(/*turbopackIgnore: true*/ process.env.PERRY_WHATSAPP_VOICE_WORKER ?? resolve("server/whatsapp-voice-worker.mjs"), [join(HOME, "models"), options.language, options.model, output], { windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore", "ipc"], serialization: "json" });
    let result: string | undefined, failure: Error | undefined;
    const abort = () => { failure = new Error("Voice transcription was stopped."); killTree(child); };
    const timer = setTimeout(() => { failure = new Error("Local transcription timed out; the original voice note remains attached."); killTree(child); }, 90_000);
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
    signal.addEventListener("abort", abort, { once: true });
    child.once("error", error => { failure = error; cleanup(); fail(error); });
    child.on("message", (message: { text?: unknown; error?: unknown }) => {
      if (typeof message.text === "string") result = message.text;
      else if (typeof message.error === "string") failure = new Error(message.error);
    });
    child.once("exit", () => { cleanup(); if (failure) fail(failure); else if (result === undefined) fail(new Error("Local transcription ended without a transcript.")); else done(result); });
    if (signal.aborted) abort();
    else child.send({ audio: audio.toString("base64") }, error => { if (error) { failure = error; killTree(child); } });
  });
}
