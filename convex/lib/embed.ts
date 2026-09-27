import { join } from "node:path";
import { HOME } from "../../runner/home";

/**
 * Sentences to vectors on this computer, so memory can be searched by meaning
 * ("what do I eat?" finds "I'm vegetarian") and not only by the words it
 * shares with the question.
 *
 * A small multilingual sentence model (about 120 MB, 8-bit), run by
 * transformers.js on ONNX Runtime in the server process, as the pet runs
 * Whisper (pet/voice.js). It is downloaded from Hugging Face the first time
 * into ~/.perry/models; after that nothing leaves the computer. Until it is
 * ready, and if it cannot load, memory search is by words alone.
 */

/** Which model; PERRY_EMBED_MODEL picks another feature-extraction model on Hugging Face. */
export const EMBED_MODEL = process.env.PERRY_EMBED_MODEL ?? "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

type Extractor = (texts: string[], options: { pooling: "mean"; normalize: boolean }) => Promise<{ tolist(): number[][] }>;
type Global = { __perryEmbedder?: Promise<Extractor>; __perryEmbedderReady?: boolean; __perryEmbedderError?: string };
// Next can load this module more than once; the model is loaded once per process.
const box = globalThis as Global;

function load(): Promise<Extractor> {
  box.__perryEmbedder ??= (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = join(HOME, "models");
    const extractor = await pipeline("feature-extraction", EMBED_MODEL, { dtype: "q8" });
    box.__perryEmbedderReady = true;
    box.__perryEmbedderError = undefined;
    return extractor as unknown as Extractor;
  })().catch((error) => {
    box.__perryEmbedder = undefined;
    box.__perryEmbedderError = error instanceof Error ? error.message : String(error);
    throw error;
  });
  return box.__perryEmbedder;
}

/** Whether vectors can be had now, without waiting for a download. */
export const embedderReady = () => box.__perryEmbedderReady === true;

/** Why the model last failed to load, if it did. */
export const embedderError = () => box.__perryEmbedderError;

/** Unit-length vectors for each text, loading (and the first time, downloading) the model if need be. */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const extractor = await load();
  return (await extractor(texts, { pooling: "mean", normalize: true })).tolist();
}

/** Vectors are unit length, so their dot product is the cosine. */
export function similarity(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Kept on a memory as base64 float32, about 2 KB for 384 numbers. */
export const packVector = (vector: number[]) => Buffer.from(new Float32Array(vector).buffer).toString("base64");
export function unpackVector(packed: string): number[] {
  // Copied, since a Buffer's bytes need not start where a Float32Array can.
  return Array.from(new Float32Array(Uint8Array.from(Buffer.from(packed, "base64")).buffer));
}

/** Start loading the model in the background, when it is wanted but not needed yet. */
export function warmUp() {
  void load().catch(() => {});
}
