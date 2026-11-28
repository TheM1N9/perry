# Concurrent optimistic saves

The existing `withOptimisticUpdate` API now preserves overlapping optimistic writes to the same query. Previously each mutation replaced one shared override, and an earlier mutation's cleanup could erase a later mutation's UI update.

Each affected query keeps the server value from the start of its current optimistic batch. Pending and successful callbacks replay in submission order over that value. A failed callback's mutation removes only its own layer. Once the last mutation affecting that query finishes its native write-and-refresh cycle, the query returns to the latest server result. Successful layers and frozen values are then evicted. Separate queries release independently, including callbacks that touched more than one query.

This follows the installed Convex client's replay contract without importing private Convex internals. Perry's HTTP protocol does not carry the query-version boundary Convex uses to identify which writes are reflected in a result. Freezing only affected queries avoids showing both a temporary addition and its committed server row while acknowledgments overlap. External edits to that same query remain beneath the optimistic view until its batch settles; other queries continue updating normally.

Callbacks can run more than once. Treat query values as immutable and capture temporary IDs and timestamps outside the callback. Optimistic creation should apply only when the initial query result was loaded. If it was initially unavailable, skip the temporary insertion rather than injecting it on a later replay whose server result may already include that write. Ordinary assignments and removals should remain idempotent.

Lock/cache invalidation discards optimistic state before another session can render. Sensitive query refreshes do the same. Closing the client aborts requests and clears subscriptions and optimistic layers. Replaying unchanged frozen values preserves their reference and does not notify subscribers merely because another query refreshed.

## Verification

The isolated integration replay used the production `BackendClient` against a disposable local HTTP server. It exercised real mutation requests, live-query refresh and subscription notifications; no owner installation, external service or provider was involved. All eight journeys passed:

1. Earlier success preserves a later optimistic addition, including a server read that already reflects the first write.
2. Earlier failure removes only its own layer.
3. Later failure preserves the earlier pending operation.
4. Independent query batches release independently.
5. A finished multi-query callback cannot refreeze a query already released.
6. A throwing callback leaves no partial optimistic state.
7. Cache invalidation and late settlement cannot revive old layers.
8. Close aborts an outstanding mutation and leaves no retained subscriptions or layers.

The replay also counted notifications: refreshing an unchanged frozen view, or an unrelated query, produced no extra notifications. It asserted complete layer/base eviction after ordinary settlement and closed its HTTP listener.

To repeat the protocol, subscribe a fresh client to two synthetic array-valued queries over a local server. Gate mutation responses independently. Begin two optimistic callbacks on the first query, complete or reject their HTTP requests in both orders, and inspect snapshots before and after each native mutation refresh. Update the real server array while the second response remains gated to verify there is no duplicate temporary addition. Repeat with separate queries and a callback touching both. Finally invalidate the cache and close the client while a request remains pending. Record snapshots, notification counts, retained-layer counts and server closure in a machine-readable result.

The failure inventory was written before the disposable replay. Its result and inventory were preserved as user verification artifacts; the task-only replay source was removed afterward. Separate native browser journeys verify the dashboard's React integration.
