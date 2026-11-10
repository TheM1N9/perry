import { randomUUID } from "node:crypto";

const LIMIT = 100_000;

/** Faster first words, fewer flushes as a reply grows; no timer owned here. */
export const streamFlushMs = (length: number) => Math.min(1_800, 120 + Math.floor(length / 1_000) * 80);

/** One request at a time. Advance the source cursor only after acknowledgment. */
export function createReplyStream(send: (packet: { offset: number; text: string; reset?: boolean; resetKey?: string }) => Promise<number | null>) {
  let latest = "";
  let acknowledged = "";
  let retrySnapshot: string | undefined;
  let retryResetKey: string | undefined;
  let pending: Promise<void> = Promise.resolve();
  return {
    update(text: string) { latest = text.slice(0, LIMIT); },
    flush() {
      pending = pending.catch(() => {}).then(async () => {
        // Coalesce updates waiting behind a request. Updates arriving during this
        // request wait for the next adaptive timer (or the final drain).
        const target = latest;
        while (retrySnapshot !== undefined || target !== acknowledged) {
          // Retry the exact packet after an ambiguous transport failure, even
          // when newer engine text arrived while its acknowledgment was lost.
          const snapshot = retrySnapshot ?? target;
          const reset = !snapshot.startsWith(acknowledged);
          const resetKey = reset ? retryResetKey ?? randomUUID() : undefined;
          const offset = acknowledged.length;
          retrySnapshot = snapshot;
          retryResetKey = resetKey;
          const length = await send({ offset, text: reset ? snapshot : snapshot.slice(offset), ...(reset ? { reset: true, resetKey } : {}) });
          if (length === null) { retrySnapshot = undefined; retryResetKey = undefined; return; }
          if (length !== snapshot.length) throw new Error("Stream acknowledgment length does not match its snapshot.");
          acknowledged = snapshot;
          retrySnapshot = undefined;
          retryResetKey = undefined;
        }
      });
      return pending;
    },
  };
}
