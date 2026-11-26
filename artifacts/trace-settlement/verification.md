# Indexed backend reads

Verified on Windows with Node 25.8.2 on 2026-11-27. The suite uses the production schema, Store, Runtime, function registry and handlers against an in-memory SQLite database. Synthetic homes and reports stay under `node_modules/.cache/performance-backend`. The scheduler stays stopped and network requests are refused; no installed Perry data, engine or paid service is used.

Run the baseline and current implementation:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/trace-settlement/run.ts node_modules/.cache/performance-backend/baseline --baseline
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/trace-settlement/run.ts node_modules/.cache/performance-backend/fixed
```

The baseline flag restores the previous two query shapes with a process-local module loader. It does not change source files or the schema. It exits 1 because the three performance assertions fail. All 65 other assertions pass. The current implementation passes all 68 assertions.

Hydration counters observe documents yielded by the actual Store query iterator. Bytes are the UTF-8 JSON size of those hydrated documents, including their metadata, rather than an estimate of disk I/O or a wall-clock benchmark.

| Journey | Previous query | Indexed query |
| --- | --- | --- |
| Settle three open steps alongside 256 completed steps | 259 documents / 2,163,932 bytes | 3 documents / 641 bytes |
| Repeat settlement with no open steps | 259 documents / 2,164,211 bytes | 0 documents / 0 bytes |
| Read an idle chat with 301 completed turns and four queued/error turns | 305 documents / 1,326,474 bytes | 4 documents / 1,555 bytes |
| Read the same chat while a turn runs | 1 turn | 1 turn |

The suite creates a nonempty legacy `doc_runSpans` table before constructing Runtime. Runtime creates `i_runSpans_by_run_status`, preserves the old row byte for byte, and SQLite's query plan reports `SEARCH doc_runSpans USING INDEX i_runSpans_by_run_status (<expr>=? AND <expr>=?)`.

Behavior checks cover successful, failed, stopped, timed-out and restarted turns; completed sibling preservation; finalized legacy repair; a newer retry sharing its run; clock skew; transaction rollback; repeated settlement; late trace events; both queued/error orderings; equal queue positions; ordinary queued work ahead of a reset wait; finalized/nonretrying exclusion; and suppression of waiting while work runs.

The prior harness registered only Codex, recovery and routing. It had become stale when finalization began calling `approvals:cancelForTurn`. The suite now registers the real application modules so the unchanged production finalization journey is exercised.

The imported-turn case also gives two turns identical queue positions and creation timestamps. It reproduced a regression in the initial optimization: concatenating queued turns before errors changed the winner of a complete comparator tie. Reading the error partition first preserves the previous index order. Both the original query baseline and the final indexed implementation pass this behavior check.

The review follow-up keeps a later retrying error with a reset wait eligible while checking that an earlier ordinary queued turn suppresses it. This distinguishes choosing the first queued turn from incorrectly choosing the first turn with waiting state. All 68 checks still pass.

Generated reports and synthetic homes are disposable after their results are recorded here. Automatic approval review rejected removing `node_modules/.cache/performance-backend` with `blocked by policy`; its synthetic reports remain, with all runtime resources closed. No alternative removal mechanism was used. The maintained suite and this record remain reproducible.
