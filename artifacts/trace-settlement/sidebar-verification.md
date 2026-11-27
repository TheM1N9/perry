# Sidebar note reads

The chat list needs Riff editing-chat IDs to exclude them. Its previous `by_live_chat` query filtered after native document hydration, so ordinary notes and memory-page content were parsed on every read.

The query now walks the existing index in descending order and stops at the first note without a live chat. Linked IDs sort ahead of missing values. This uses the runtime's existing async iterator; breaking the loop closes its SQLite cursor. No schema, stored metadata, filter semantics or database implementation changes are required.

Run the maintained native replay:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/trace-settlement/run.ts node_modules/.cache/performance-backend/sidebar-current
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/trace-settlement/run.ts node_modules/.cache/performance-backend/sidebar-original --sidebar-baseline
```

The current run passes all 90 checks. The baseline restores only the previous sidebar query and fails three hydration assertions while passing all other checks. Its synthetic fixture contains 120 ordinary notes and four Riff documents, including duplicate and orphan chat references. The current endpoint hydrates four Riffs and one boundary note in one SQL query. The original hydrates all 124 notes. Response summaries, ordering and status remain identical.

Other cases cover an empty table, ordinary notes without Riffs, the notes invalidation dependency, malformed imported null references, the existing descending index without a temporary sort, and a file-backed Runtime query followed by another connection's write, an original-connection write and an unblocked WAL checkpoint. The disposable cursor database is removed after verification. No live database, network, model or phone is used.
