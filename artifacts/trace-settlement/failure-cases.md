# Trace settlement failure cases (before E2E source)

1. A command starts and never completes; finishTurn succeeds, fails, stops, times out, or reports restart. The persisted command must become error, never ok, with endedAt and nonnegative duration.
2. A successful, failed, or declined step already finished. Settlement must leave its entire row unchanged, including its output and timing.
3. Final trace transport fails or the runner's in-memory trace is lost. Server settlement must work without runner drain or a final trace report.
4. An old running update arrives after a completed event, while the turn still runs. It must not reopen or overwrite the terminal row.
5. A late completion or new span arrives after finishTurn/recovery. It must not change settled rows or create new running rows.
6. finishTurn, markFinalized, or recovery is repeated with a later clock. Existing terminal rows and their original end times must remain identical.
7. The runner disappears with an open step. Recovery must settle it in the same transaction that marks the turn terminal; final delivery must not be required first.
8. A busy conversation has no live turn but still has a running run and open step. Recovery's orphan-run path must close both.
9. A terminal turn awaits finalization or was already finalized with a legacy open step. Recovery must repair the open step using the original turn end time, without changing completed siblings or settling a newer retry of the same run.
10. A retryable plan-limit refusal leaves an open reasoning step. That attempt's steps must close, while its shared run can continue on the next attempt. The prior attempt must never settle the new attempt's spans during recovery.
11. A stopped turn has no error text and status done. Its parent run must not become ok; completed tool steps may still remain ok.
12. A runner's clock is ahead of the server's settlement clock. End must not precede start and duration must not be negative.
13. One run settles beside another running run. The other run must remain untouched.
14. A step already has partial output. Settlement must preserve it, use a fixed safe fallback only when output is absent/empty, and avoid storing unredacted turn error text.
15. Large traces must be read via a run/status index, not a global scan or arbitrary take limit that leaves open steps behind. Completed step payloads must not be hydrated just to discover there is nothing to settle.
16. A transaction fails after settlement. Real runtime rollback must undo settlement, so a partial terminal write cannot leak.
17. Local trace receives a late start/update/completion or usage event after drain. It must remain closed and not schedule new activity; failed reports may retry their latest terminal state.
18. After #244 integration, a limit fixture omits the authoritative errorCode and accidentally expects message-text classification. The coded limit must retry, while a legacy text-only limit must settle its spans without claiming a coded limit or authorizing retry.
19. An existing, nonempty runSpans table predates the run/status index. Opening the actual Runtime must create the index without losing its rows, and SQLite must use it for run/status bounds.
20. A run has hundreds of large completed payloads beside a few open steps, then is settled again. The first pass must hydrate only open steps; the repeat must hydrate no span documents, while preserving terminal siblings byte for byte.
21. An idle chat has large completed history plus queued and retrying-error turns. The waiting lookup must hydrate only queued/error partitions and preserve the selected queue position, including ties resolved by creation time.
22. A finalized queued/error turn or a nonretrying error must not supply waiting state. An earlier ordinary queued turn without waiting must suppress a later waiting turn, and a running turn must suppress waiting entirely.
23. Imported turns can share both queue position and creation time. Combining indexed status partitions must preserve the previous index order when the queue comparator ties completely.
24. The ordinary-queue suppression case must keep a later retrying error with a real reset wait eligible. Otherwise a broken first-waiting-turn lookup can pass without honoring the first queued turn.
25. A long-running job falls behind more than twenty newer completed runs. Global pet activity must still find the active run, without hydrating completed run history.
26. Multiple active runs have creation order different from start order. Global activity must choose the latest start, while terminal runs of any status are excluded. No active runs must return null.
27. The selected active run retains its live step, approval and heartbeat behavior. A chat-specific query must still return its latest completed run and summary rather than adopting the global active-only filter.

Scope: production mutation handlers + local SQLite/transaction runtime, synthetic runner/turn rows only; no network, engines, browser, scheduler start, or installed Perry data. Integrated build/E2E is the coordinator's responsibility. Each run must emit compact result.json with explicit assertions and before/after span rows.
