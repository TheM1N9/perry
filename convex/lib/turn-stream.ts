import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { internal } from "../_generated/api";

export const STREAM_LIMIT = 100_000;
const TELEGRAM_EDIT_MS = 1_500;
type Reader = Pick<QueryCtx, "db">;

export const streamState = (ctx: Reader, turnId: Id<"codexTurns">) => ctx.db.query("turnStreams")
  .withIndex("by_turn", (q) => q.eq("turnId", turnId)).unique();
const chunksOf = (ctx: Reader, turnId: Id<"codexTurns">) => ctx.db.query("turnStreamChunks")
  .withIndex("by_turn_offset", (q) => q.eq("turnId", turnId)).collect();

/** Strip the private footer after assembly, including one split across chunks. */
export const visibleStream = (text: string) => text.replace(/\n[ \t]*m(?:e(?:m(?:o(?:r(?:i(?:e(?:s(?::[^\n]*)?)?)?)?)?)?)?)?[ \t]*$/i, "").slice(0, STREAM_LIMIT);

export async function streamBody(ctx: Reader, turn: Pick<Doc<"codexTurns">, "_id" | "partial">): Promise<string | undefined> {
  if (!await streamState(ctx, turn._id)) return turn.partial;
  return visibleStream((await chunksOf(ctx, turn._id)).map((chunk) => chunk.text).join(""));
}

export async function deleteStream(ctx: MutationCtx, turnId: Id<"codexTurns">) {
  for (const chunk of await chunksOf(ctx, turnId)) await ctx.db.delete(chunk._id);
  const state = await streamState(ctx, turnId);
  if (state) await ctx.db.delete(state._id);
}

/**
 * Offsets refer to engine text (UTF-16), not its redacted display. Each ordinary
 * append inserts only its delta and rewrites one bounded metadata document.
 * Serialized retries with an already committed offset are acknowledged once.
 */
export async function appendStream(ctx: MutationCtx, turn: Doc<"codexTurns">, offset: number, text: string, reset = false, resetKey?: string) {
  let state = await streamState(ctx, turn._id);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > STREAM_LIMIT) throw new Error("Invalid stream offset.");
  const length = state?.length ?? 0;
  if (!reset && offset < length) return length;
  if (!reset && offset !== length) throw new Error("Stream offset does not follow the stored text.");
  text = text.slice(0, STREAM_LIMIT - (reset ? 0 : offset));
  // The runner reuses a random ID for an exact reset packet. Keep that ID in
  // bounded metadata: comparing body text after vault scrubbing
  // would mistake an ambiguous-commit retry for a new reset and restore secrets.
  if (resetKey !== undefined && (!reset || resetKey.length < 1 || resetKey.length > 100)) throw new Error("Invalid reset request ID.");
  if (resetKey && state?.resetKey === resetKey) return length;
  if (!reset && !text) return length;
  if (reset) for (const chunk of await chunksOf(ctx, turn._id)) await ctx.db.delete(chunk._id);
  if (!state) {
    const id = await ctx.db.insert("turnStreams", {
      turnId: turn._id, length: 0,
      ...(turn.telegramMessageId !== undefined ? { telegramMessageId: turn.telegramMessageId } : {}),
      ...(turn.telegramEditedAt !== undefined ? { telegramEditedAt: turn.telegramEditedAt } : {}),
      ...(turn.telegramEditing !== undefined ? { telegramEditing: turn.telegramEditing } : {}),
    });
    state = (await ctx.db.get(id))!;
  }
  const nextLength = (reset ? 0 : offset) + text.length;
  if (text) await ctx.db.insert("turnStreamChunks", { turnId: turn._id, offset: reset ? 0 : offset, text });
  const conversation = await ctx.db.get(turn.conversationId);
  const edit = conversation?.channel === "telegram" && !turn.flush && !turn.checkpoint && !state.telegramEditing
    && Date.now() - (state.telegramEditedAt ?? 0) >= TELEGRAM_EDIT_MS;
  await ctx.db.patch(state._id, {
    length: nextLength,
    ...(resetKey ? { resetKey } : {}),
    ...(edit ? { telegramEditing: true, telegramEditedAt: Date.now() } : {}),
  });
  if (edit) await ctx.scheduler.runAfter(0, internal.codex.streamToTelegram, { id: turn._id });
  return nextLength;
}

/** Compatibility for older runners sending cumulative snapshots. */
export async function snapshotStream(ctx: MutationCtx, turn: Doc<"codexTurns">, text: string) {
  text = text.slice(0, STREAM_LIMIT);
  const state = await streamState(ctx, turn._id);
  const before = state ? (await chunksOf(ctx, turn._id)).map((chunk) => chunk.text).join("") : "";
  if (text === before && state) return;
  if (!state && !text) await appendStream(ctx, turn, 0, "", true);
  else if (text.startsWith(before) && (!state || state.length === before.length)) await appendStream(ctx, turn, state?.length ?? 0, text.slice(before.length));
  else await appendStream(ctx, turn, state?.length ?? 0, text, true);
}

/** Save-secret erases values even across chunk boundaries, retaining source offsets. */
export async function scrubStream(ctx: MutationCtx, turnId: Id<"codexTurns">, scrub: (text: string) => string) {
  const chunks = await chunksOf(ctx, turnId);
  const before = chunks.map((chunk) => chunk.text).join("");
  const after = scrub(before);
  if (after === before) return false;
  for (const chunk of chunks) await ctx.db.delete(chunk._id);
  // Keep state's source length: the live runner still appends in engine coordinates.
  if (after) await ctx.db.insert("turnStreamChunks", { turnId, offset: 0, text: after });
  return true;
}
