# Trace settlement

`convex/lib/settle-traces.ts` closes persisted `runSpans` in the mutation that
ends their turn. Runner `TurnTrace.drain()` remains useful, but its final report
may fail, the process may restart without its in-memory spans, or recovery may
end a turn before a runner returns. Final message delivery must not be required
for database trace cleanup.

Call `settleRunSpans(ctx, runId, endedAt, reason)` before scheduling finalization
in finishTurn (including the retry branch), recovery abandonment, and orphan-run
recovery. Finalization is an additional repair boundary. It returns the number
of changed rows. It uses the existing `by_run` index and patches only rows whose
status is still `running`. Existing `ok`, `error`, and `declined` rows remain
unchanged; repeated calls retain their original end time and content.

Unfinished work becomes `error`, including when the enclosing reply succeeds.
A stopped reply must also finalize its parent run as `error`, with a safe stop
explanation. A finished command can remain `ok` inside a failed/stopped run.
The current span status vocabulary already expresses failure; cancellation does
not mean the tool declined its approval, and should not be recorded `declined`.

The integration adds optional `endedAt` to span schema and trace validators.
Optional keeps old rows and old runners valid. Duration remains available to
existing consumers. Settlement calculates both from one caller-supplied end
time, clamped to startedAt for runner/server clock skew. Normal completed
events derive endedAt from their duration, falling back to receipt time for old
terminal events without timing. No terminal timestamp is guessed for a running
event. Existing partial output is retained; absent output gets fixed safe text,
never a raw engine error that may contain secrets.

Trace ingestion must refuse reports after the turn or run is terminal, and skip
updates to already-terminal spans while a turn is running. Local TurnTrace must
also reject updates to terminal items and all events after drain. Together these
prevent old start/update events from reopening an ended step.

Recovery can repair legacy open spans on terminal turns using their original
finishedAt, but must skip an old retry attempt while a newer queued/running
attempt shares its run. An old refused turn must not close the next attempt's
work. Do not limit settlement to a small prefix of spans.

`artifacts/trace-settlement/run.ts` exercises actual backend mutations and SQLite transactions with synthetic data and no engine calls. Its failure inventory is `artifacts/trace-settlement/failure-cases.md`. The integrated native Node run passed 51 checks; reproduction and final evidence are in `artifacts/batch-1/README.md`. This validates backend settlement and the trace adapter without running a real engine process. The combined browser journey verifies terminal trace presentation.