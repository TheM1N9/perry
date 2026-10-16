# Isolation and failure cases (recorded before E2E code)

- Dynamic imports could read defaults/credentials: set synthetic PERRY_HOME, PERRY_DB, DASHBOARD_KEY and PERRY_CREDENTIAL_KEY before all project imports; never import bootstrap.
- Scheduler could execute real actions: stop Runtime before mutations, omit crons and use fake scheduled action definitions.
- Network/engine calls could escape: replace fetch with a local Runtime/SSE adapter rejecting all other URLs; no engines or CLIs.
- Scratch could exceed cap: in-memory SQLite, 240 bounded synthetic bodies, compact JSON, no screenshots/video/dependency copies.
- An index could still decode all Brain rows: instrument actual Store.rows yields, verify only ordinary notes are decoded for notes:list.
- Table-wide invalidation could still rerun Notes: count actual notes:list handler calls through BackendClient, exercise both mutation return writes and SSE events.
- Narrow dependencies could miss empty-list inserts, deletes, kind transitions, ordinary content/pin/project edits, mixed mutations or legacy import/restore events: verify both old/new kinds, absent-kind insert, removal, and broad fallback; retain full-table tags for all existing queries.
- Rollbacks could publish invalidation or persist partial data: verify failed mutation emits no events and leaves data unchanged.
- Ordering could change because by_kind orders by day/creation: sort ordinary results by updatedAt then _creationTime descending.
- Search/previews/revisions/permissions could regress: use actual notes handlers for create/save/search/move/pin/remove and assistant journal append, wrong dashboard key and sealed chat access.
- An overlay could accidentally mask shared work: proposed shared sources are generated only from current exact source, stored under this issue; loader maps only three explicit shared paths. Never apply proposal to checkout.
- Reconnect is intentionally a full refresh; establish stable stream before recording journal no-rerun baseline. Bound waits and close client/runtime/database on completion.

## Integrated review: mixed-event reproduction (recorded before adding harness)

- Current Runtime import and mutation events are separate; do not report a production coalescing bug without a source path. Read actual SSE route and client loop first.
- Combining a broad notes import tag with notes:scoped-write loses broad provenance in the flat Set. Reproduce by buffering only two real Runtime events in a synthetic adapter, then transmitting their union through the actual BackendClient SSE path.
- Before transmitting the union, verify the import really committed; after transmission inspect query execution count AND cached list membership, then send a broad-only event to verify recovery. Report this as an intentionally injected merge, not current SSE behavior.
- Keep original integrated evidence separate; use a new compact mixed-event evidence file. No shared-file edits, bootstrap, real data/network, or engine. Keep same isolation and stopped scheduler as original E2E.

## Fixed mixed-event verification (before changing harness expectations)

Preserve the prior reproduction artifact. In the fixed integration, a broad import must explicitly include notes:ordinary so the union remains invalidating. Assert the union tag, a real Notes handler rerun and the imported note in cached results. Retain the prior revision/search/access/isolation coverage. The updated check must not treat the former stale-cache behavior as success. A focused importer compile must emit no files and must not import/bootstrap the application at runtime.
