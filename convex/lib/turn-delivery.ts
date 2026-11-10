import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Runtime actions run alongside one another in this single server process.
 * Order draft and final deliveries for one turn, acquiring this before reading
 * getTurn so a finalizer sees the draft ID saved by any preceding send. Durable
 * finalization ownership/replay remains in beginFinalize and its recorded steps.
 */
const deliveries = new Map<string, Promise<unknown>>();
const delivering = new AsyncLocalStorage<ReadonlySet<string>>();

export async function deliverTurnInOrder<T>(id: string, deliver: () => Promise<T>): Promise<T> {
  const parents = delivering.getStore();
  // A nested same-turn finalizer cannot wait for the caller that awaits it.
  // Reject rather than deadlock or bypass the durable finalization checks.
  if (parents?.has(id)) throw new Error("Recursive delivery for the same turn is not allowed.");
  const previous = deliveries.get(id) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(() => delivering.run(new Set([...(parents ?? []), id]), deliver));
  deliveries.set(id, current);
  try {
    return await current;
  } finally {
    if (deliveries.get(id) === current) deliveries.delete(id);
  }
}
