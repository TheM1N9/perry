import { join } from "node:path";
import { HOME } from "../../runner/home";

/**
 * Sentences to vectors on this computer, so memory can be searched by meaning
 * ("what do I eat?" finds "I'm vegetarian") and not only by the words it
 * shares with the question.
 *
 * A small multilingual sentence model, 8-bit, run by transformers.js on ONNX
 * Runtime in the server process, as the pet runs Whisper (pet/voice.js). It
 * is downloaded from Hugging Face the first time into ~/.perry/models; after
 * that nothing leaves the computer. Until it is ready, and if it cannot load,
 * memory search is by words alone.
 *
 * Which model was measured, not guessed (issue #220, artifacts/brain-scale/
 * models.ts): on a synthetic three-year Brain and on LongMemEval-S, against
 * the model before it, EmbeddingGemma-300m and bge-m3. When the model
 * changes, every line is embedded again in the background (memories.
 * embedMissing), and search uses both models' vectors until it is done.
 */

export type EmbedModel = {
  id: string;
  /** What goes before a question, and before a line, as the model's card asks. */
  query: string;
  passage: string;
  pooling: "mean" | "cls";
  dimensions: number;
};

/** Models Perry knows how to run; another id from PERRY_EMBED_MODEL runs with mean pooling and no prefixes. */
const KNOWN: EmbedModel[] = [
  { id: "Xenova/multilingual-e5-small", query: "query: ", passage: "passage: ", pooling: "mean", dimensions: 384 },
  { id: "Xenova/paraphrase-multilingual-MiniLM-L12-v2", query: "", passage: "", pooling: "mean", dimensions: 384 },
  { id: "Xenova/bge-m3", query: "", passage: "", pooling: "cls", dimensions: 1024 },
];
export const modelInfo = (id: string): EmbedModel => KNOWN.find((model) => model.id === id) ?? { id, query: "", passage: "", pooling: "mean", dimensions: 0 };

/** Which model; PERRY_EMBED_MODEL picks another feature-extraction model on Hugging Face. */
export const EMBED_MODEL = process.env.PERRY_EMBED_MODEL ?? KNOWN[0].id;

type Extractor = ((texts: string[], options: { pooling: "mean" | "cls"; normalize: boolean }) => Promise<{ tolist(): number[][] }>) & { dispose?: () => Promise<void> };
type Global = { __perryEmbedders?: Map<string, Promise<Extractor>>; __perryEmbeddersReady?: Set<string>; __perryEmbedderError?: string };
// Next can load this module more than once; each model is loaded once per process.
const box = globalThis as Global;
box.__perryEmbedders ??= new Map();
box.__perryEmbeddersReady ??= new Set();

function load(model: string): Promise<Extractor> {
  const loaded = box.__perryEmbedders!.get(model);
  if (loaded) return loaded;
  const loading = (async () => {
    const { pipeline, env } = await import("@huggingface/transformers");
    env.cacheDir = join(HOME, "models");
    const extractor = await pipeline("feature-extraction", model, { dtype: "q8" });
    box.__perryEmbeddersReady!.add(model);
    box.__perryEmbedderError = undefined;
    return extractor as unknown as Extractor;
  })().catch((error) => {
    box.__perryEmbedders!.delete(model);
    box.__perryEmbedderError = error instanceof Error ? error.message : String(error);
    throw error;
  });
  box.__perryEmbedders!.set(model, loading);
  return loading;
}

/** Whether vectors can be had now from a model, without waiting for a download. */
export const embedderReady = (model = EMBED_MODEL) => box.__perryEmbeddersReady!.has(model);

/** Why a model last failed to load, if one did. */
export const embedderError = () => box.__perryEmbedderError;

/** Unit-length vectors for each text, as questions or as lines, loading (and the first time, downloading) the model if need be. */
export async function embed(texts: string[], as: "query" | "passage" = "passage", model = EMBED_MODEL): Promise<number[][]> {
  if (texts.length === 0) return [];
  const info = modelInfo(model);
  const extractor = await load(model);
  const prefix = as === "query" ? info.query : info.passage;
  return (await extractor(texts.map((text) => prefix + text), { pooling: info.pooling, normalize: true })).tolist();
}

/** A model no longer needed (the one before, once every line has the new one's vectors) leaves memory. */
export async function unload(model: string) {
  const loading = box.__perryEmbedders!.get(model);
  if (!loading || model === EMBED_MODEL) return;
  box.__perryEmbedders!.delete(model);
  box.__perryEmbeddersReady!.delete(model);
  await (await loading.catch(() => null))?.dispose?.().catch(() => {});
}

/** Vectors are unit length, so their dot product is the cosine. */
export function similarity(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length && i < b.length; i++) sum += a[i] * b[i];
  return sum;
}

/** A vector kept inside a row before issue #220: base64 float32. */
export function unpackVector(packed: string): number[] {
  // Copied, since a Buffer's bytes need not start where a Float32Array can.
  return Array.from(new Float32Array(Uint8Array.from(Buffer.from(packed, "base64")).buffer));
}

/** Start loading the model in the background, when it is wanted but not needed yet. */
export function warmUp(model = EMBED_MODEL) {
  void load(model).catch(() => {});
}

/**
 * Whether the model is ready, waiting up to `ms` for it to load: a search
 * just after Perry starts waits the few seconds a model already downloaded
 * takes, rather than going by words alone. A first download is not waited for.
 */
export async function readyWithin(ms: number, model = EMBED_MODEL): Promise<boolean> {
  if (embedderReady(model)) return true;
  const loading = load(model).then(() => true, () => false);
  return await Promise.race([loading, new Promise<boolean>((done) => setTimeout(() => done(false), ms))]);
}
