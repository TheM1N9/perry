# Turn liveness (#243)

A long task can be silent while its computer is healthy. Engine output and execution duration are therefore not heartbeat deadlines.

The runner's existing 30-second `runner.checkIn` reports the IDs in its active map. The server authenticates the runner, queries its running turns with `by_runner_status`, and updates only matching owned running turns. Claim and stream mutations also record genuine liveness. `lastHeartbeatAt` is server time, not a runner-supplied timestamp. Every heartbeat clears `unresponsiveAt`; it never changes execution status. Done/error/finalized turns ignore late beats, streams, and results through the existing terminal guards.

`turnHealth` computes warning and settlement independently:

| Situation | Warning | Settlement |
| --- | --- | --- |
| Explicitly heartbeating running turn | At 90 seconds without this turn's beat | At 15 minutes without this turn's beat |
| Older runner that omits active IDs | At 90 seconds without machine heartbeat | At 15 minutes without machine heartbeat |
| Queued turn | Dashboard keeps existing queued behavior | At 10 minutes after last machine heartbeat or creation, whichever is later |

The recovery cron runs every 30 seconds, so a disconnected running turn gains its reactive warning at 90–120 seconds. A chat opened after 90 seconds computes the warning immediately. A genuine check-in clears it reactively. Existing engine idle/max-time watchdogs and `take_longer` remain independent: keeping a runner alive does not certify model progress, and asking for longer cannot hide a disconnected computer.

`runners.turnHeartbeats` records whether the latest check-in included active IDs. Omission supports older runners. An explicit empty array means no turns are currently owned. When upgrading from machine-only heartbeats, omitted running turns freeze at their last valid machine heartbeat; unrelated future check-ins cannot prolong them. Downgrading to an older runner restores machine-heartbeat compatibility.

Recovery supplements its recent history with queued/running queries for every runner (and legacy unassigned turns), using the existing index. More than 300 newer completed turns cannot hide an older active turn. It preserves partial output when abandoning a turn, settles open trace spans as interrupted through `settleRunSpans`, and schedules the existing durable finalization. The run remains active during reconnect grace. The UI shows a waiting reconnect warning, preserves partial text, and pauses stale activity spinners without inventing tool success.

A refused turn awaiting routing owns its run for ten minutes. Finalization cannot acquire that run while retrying; replacement execution cannot start after the deadline or any delivery evidence. A durable targeted recovery callback releases an abandoned retry atomically before scheduling finalization, including behind more than 300 newer history rows. This keeps retry and delivery recovery mutually exclusive.

Verification source is `artifacts/turn-health/run.ts`; its failure inventory is `artifacts/turn-health/failure-cases.md`. The integrated native Node run passed 22 fake-runner Runtime/SQLite journeys. Reproduction commands, final build checks and disposable browser evidence are in `artifacts/batch-1/README.md`.