# Failure cases before E2E source (#243)

1. A healthy quiet turn is falsely timed out because it started hours ago or produced no tokens.
2. A runner heartbeat without this active turn falsely keeps its abandoned turn alive.
3. A sleeping/disconnected computer still shows ordinary thinking after the 90-second liveness deadline.
4. A real beat during reconnect grace leaves the warning stuck or restarts execution/loses partial output.
5. A short disconnect of an old turn immediately settles it instead of granting grace from its last beat.
6. A beat, stream, or saved completion arriving after error/finalization reopens a terminal turn.
7. A runner can heartbeat another runner's turn or a queued/done/error turn.
8. Omitted active IDs from a legacy runner break compatibility; an explicit empty list is mistaken for omission.
9. More than 300 newer finished turns hide an older active turn from recovery.
10. Queued offline turns never settle, settle before the offline grace, or settle based solely on creation after a long healthy queue wait.
11. Repeated sweeps duplicate finalization, lose partial text, or warn/settle a finalized turn.
12. Revoked/missing runner is displayed as responsive; future/duplicate observations regress heartbeat time.
13. Fake-clock evidence changes wall-clock services or tests accidentally import project code before setting PERRY_HOME and synthetic DASHBOARD_KEY.
14. Tests hang, use real engines/model calls, or create large artifacts.
15. UI continues showing stale tool activity/thinking over the unresponsive warning, or heartbeat cannot clear the warning reactively.

Verification design: a bounded in-process Perry Runtime with its real SQLite Store and production mutations; fake clock and authenticated fake runner payloads. No HTTP server, timers, crons, engines, or external network. All state and JSON evidence in .batch-work/batch-1/243. Coordinator also verifies the warning in combined browser E2E after applying integration.patch. Terminal late-beat assertions apply to both error and done.

## Retry/finalization ownership failure cases (written before expanded E2E)

16. A recovery sweep at 60 seconds finalizes a still-owned routing retry before a bounded retry grace expires.
17. beginFinalize accepts a retrying turn or a nonterminal turn, allowing delivery while execution/retry owns it.
18. markFinalized bypasses retry ownership, closes the shared run, or decrements pendingTurns while retry is pending.
19. retryOn starts after finalization acquired a lease, after that lease expired, after saved/reported/delivered evidence, or after the parent run already ended.
20. When retry wins first, a stale finalizer starts or closes traces belonging to the replacement turn; when finalization wins first, a stale retry creates a replacement turn or mutates chat routing.
21. Abandoned retrying turns never release; grace restarts on sweeps instead of being measured from finishedAt; exact boundary is off by one.
22. Legacy mixed retrying+finalizing/delivery state remains stuck or gets re-executed; expired delivery lease permits duplicate execution rather than delivery recovery.
23. More than 300 new turns hide an abandoned retry from the global history window; durable targeted fallback must still find it.
24. Repeated recovery or late routing give-up schedules duplicate finalizers whose atomic claim fails to reject competing actions.
25. Verification runs old shared codex source instead of the proposed patch, accidentally edits shared source to test it, or uses real credentials/models.

E2E expansion: production Runtime mutations, fake runner/clock, memory SQLite. Native Node load hook overlays only the exact proposed codex source at its original URL (relative imports unchanged), with SHA256 evidence. Test both ownership orderings, exact retry grace, direct mutation bypasses, legacy delivery markers, dead parent run, durable fallback registration, and >300 history targeted recovery. Existing liveness journeys remain enabled. Scheduler stays stopped; fake finalization is advanced through production beginFinalize/markFinalized mutations, so no models/channel delivery run.

26. A delayed routing action starts a replacement after the retry grace deadline but before the recovery callback has executed (e.g. scheduler resumes after downtime). retryOn must enforce the same deadline atomically, independently of sweep ordering.
