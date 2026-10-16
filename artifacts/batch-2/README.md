# Batch 2 reliability review

Development branch: `codex/batch-2-reliability`, based on merged PR297
(`350f79406d89c29edf046a72f6e4f8bc5ae1d7b3`). This batch has not been merged or
deployed. Installed Perry and its data/configuration were not accessed or changed.

## Changes

- #247: ten waiting messages per chat across turns, pending steers and fresh
  outbox reservations. Remove one durable unclaimed message without stopping the
  active turn. Durable run replay/removal is idempotent. Fixed identical expired
  outbox entries consuming the wrong reservation.
- #254: record explicit credential expiry for the exact account used, keep active
  alternatives healthy, and reconnect the original account using the installed
  Composio SDK. An ACTIVE response that still needs an OAuth redirect is not
  reported as successful. Provider error payloads are not persisted in health.
- #238: acknowledged append-only stream deltas with adaptive flushes; chat
  metadata no longer subscribes to the growing body. Preserve recovery, final
  delivery, pet and terminal consumers. Reset request IDs keep ambiguous retries
  from restoring secrets scrubbed by vault.save. Order Telegram drafts and final
  delivery; draft requests and rate-limit waits have a native 15-second deadline.
  Finalization removes temporary stream chunks and metadata after preserving the
  terminal response and completing its saving/delivery steps.
- #236: composer owns draft/caret state, live rows own clocks, historical rows
  retain identity and use memo, and live streaming subscribes in its own leaf.
  Native ResizeObserver keeps bottom-following without screen stream state.
- #250: Notes uses the existing kind index and a narrow invalidation scope, so
  Brain journal updates neither decode Brain bodies nor rerun the Notes list.
  Imports include the ordinary-note tag even if events are later combined.

## Recorded verification

Backend evidence is synthetic actual Runtime/SQLite E2E, with the scheduler
stopped before mutation and fake network/engines. Source overlays are not used in
the final runs. `247/`, `250/`, `254/` and `238/` contain repeatable harnesses and
compact results. Failure inventories predate the E2E code.

Production UI profiling used `next build --profile --no-mangling` and a pre-React
DevTools commit hook. The probe excludes reused bailout fibers, records actual
durations, and has a changed-row positive control. Raw commits are in
`profile-*.json`; the concise functional record is `ui-result.json`.

| Browser phase | ChatScreen updates | MessageRow updates | Other evidence |
| --- | ---: | ---: | --- |
| 30 keys, 10 caret moves, Shift+Enter; 200 saved messages loaded | 0 | 0 | ComposerDraft/Composer 42 updates; exact draft/caret preserved |
| 25 clock ticks | 0 | 0 | Only LiveReply/ReplyInProgress updated |
| New delta stream text | 0 | 0 | Text visible |
| One changed saved message | 3 | 1 | Positive control confirms row instrumentation |

The legacy cumulative-stream endpoint can update chat metadata at its bounded
30-second heartbeat cadence (one observed update). The new runner delta path
does not. An older reader's scroll position stayed fixed during a stream update.
Full queue refusal preserved the draft; removing the middle queued message kept
the active reply and other nine controls; a subsequent send succeeded. Access
help and draft lifetime across navigation were also checked. The tab and exact
command-verified disposable server were closed afterward.

Batch1 encryption, steering, heartbeat, error and terminal-trace E2Es also passed
on the integrated tree. Error/trace suites were repeated after the final delivery
ordering change. Build/typecheck outcomes are recorded in `verification.json`.

## Repeat

Use existing dependencies only, from the repository root. No install/download is
needed. Native Node is required for node:sqlite; do not use normal Perry startup.

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/batch-2/247/e2e.mjs
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs --import ./artifacts/batch-2/254/fake-loader.mjs artifacts/batch-2/254/run.mjs
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/batch-2/250/e2e.mjs
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/batch-2/250/mixed-event-e2e.mjs
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/batch-2/238/e2e.mjs --lifecycle
powershell -NoProfile -File artifacts/batch-2/run-isolated.ps1 -Mode Build
powershell -NoProfile -File artifacts/batch-2/run-isolated.ps1 -Mode UI
```

The UI wrapper clears inherited application environment and blocks dotenv reads.
It seeds a fresh batch-only home, provides a stopped Runtime singleton, blocks
child processes/remote server fetch, and proxies loopback HTML to inject the
profiling probe. Read its printed fixture URL. Load earlier messages three times
until all 200 saved rows appear, expand Fixture profiling, name/reset the phase,
and type in the real composer. `change-fixture-message.mjs` changes one guarded
synthetic row and uses the normal query invalidation path as a positive control.
Never use these helpers against a normal running installation.

## Limits

Real engine/model execution and real provider OAuth were intentionally unrun.
Browser acceptance did not cover a screen reader, mobile viewport, or the entire
attachment/editor/approval/landing journey. Backend authorization, failed/replayed
mutations, liveness, delivery and restoration paths have separate E2E coverage.

Pending steers and preparing outbox entries reserve queue capacity but cannot be
removed through the unclaimed-turn control. HTTP send replay without a stable
caller idempotency key retains existing behavior. Body reads still assemble up
to 100k UTF-16 units; append JSON payload growth is measured separately from
SQLite WAL/page/index overhead. Runtime invalidation is otherwise table-wide.

Delivery ordering is local to Perry's single server process. The durable
finalization lease and steps remain the restart authority. Timeout or process
crash cannot establish whether Telegram accepted an unacknowledged first send;
an orphan/duplicate draft remains possible. No exactly-once external delivery
claim or blind retry of final/file writes is introduced.
