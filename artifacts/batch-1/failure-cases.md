# Batch 1 browser journey failure inventory (before harness)

1. A test server loads real dotenv/home/credentials or starts cron, services,
   wake tasks, model downloads or a real engine. Fail closed on missing explicit
   UI test opt-in; use a fresh batch-only home. Preseed the existing backend
   singleton with a stopped real Runtime and started=true so instrumentation
   skips startBackend. Block remote fetch and child processes in this process.
2. Incorrect fixtures bypass production backend mutations or omit schema fields.
   Seed through the real Runtime Store and use production HTTP handlers for all
   subsequent heartbeat, steering, acknowledgement and completion transitions.
3. Unresponsive warning is hidden under stale tool/thinking indicators, does not
   preserve partial text, or never clears on authenticated turn heartbeat.
4. Completed/failed trace stays animated after finish/finalize or late events
   overwrite settled data. Inspect settled steps after a real terminal mutation.
5. Error code presentation guesses from prose, exposes saved values in Details,
   duplicates banners or retries a different run. Seed linked saved messages;
   inspect code-specific recovery/Details and avoid executing a real retry.
6. Steering form lacks an accessible label, loses draft on failure, sends a
   duplicate instruction, claims delivery before ack or erases completed steps.
   Use fake runner, production steer/ack handlers and verify visible transitions.
7. Browser resources use installed app port/profile, frontend attempts telemetry,
   page overflows, controls cannot be reached, or the test hangs/leaves services.
   Use in-app test tab and port17483 only, inspect a screenshot and DOM, stop only
   this test process. Keep compact JSON evidence and no videos/browser downloads.

Scope: real rendered production UI and HTTP/backend transitions, fake runner
and fixtures. No real CLI/model execution, user data or installed app changes.
