# Fake-runner turn-health journey (#243)

Run the native Node command in `artifacts/batch-1/README.md` from the repository root. `failure-cases.md` records the failure inventory written before the harness.

`run.ts` uses real Perry mutations and SQLite Store, a fake clock, and authenticated fake runner reports. The scheduler is stopped before mutations, so no models or channel delivery run. It writes `.batch-work/batch-1/243/result.json` even on failure.

The final integrated run passed 22 journeys covering healthy long silence, the 90-second warning, reconnect and grace deadlines, partial preservation, ignored late terminal writes, orphan/foreign/legacy runner behavior, history-volume visibility, retry/finalization ownership and bounded retry recovery. Combined browser verification is recorded in `artifacts/batch-1/verification.json`.
