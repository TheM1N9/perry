# Batch 1 verification

Development branch: `codex/batch-1-reliability`. This batch changes source only;
it does not update, restart or migrate the installed Perry.

| Issue | Result | Final isolated verification |
| --- | --- | --- |
| #251 | Encrypt saved credentials and migrate existing SQLite/JSON backups; recover interrupted staging safely | 23 scenarios |
| #281 | Steer running tasks, retain acknowledgement outcomes, protect accepted follow-ups through retries | 62 checks |
| #243 | Warn on lost turn heartbeat, allow reconnect grace, coordinate routing retry and finalization | 22 journeys |
| #244 | Persist stable error codes and show recovery guidance for the correct turn | 21 cases |
| #245 | Settle interrupted trace spans and ignore late terminal events | 51 checks |

All rows passed against the final integrated source using real Runtime/SQLite
and production handlers with fake runners/engines. Failure inventories are
stored beside each harness. The final raw results are the five JSON files here.
Backend/full TypeScript and the production build passed. The build retains two
existing dynamic filesystem tracing warnings in `convex/pet.ts` and
`server/wake.ts`. `verification.json` records commands, counts and source hashes.

## Reproduce backend checks

Run these separately from the repository root with the existing dependencies
and Node 25 (native SQLite and TypeScript transformation). They set isolated
homes and synthetic keys before importing project code; no real engines or
external channels are called.

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/secrets-at-rest/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-steering/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/turn-health/run.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/turn-errors/e2e.ts
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/trace-settlement/run.ts .batch-work/batch-1/245/results-final
pnpm exec tsc --noEmit --incremental false -p convex/tsconfig.json
pnpm exec tsc --noEmit --incremental false
```

For the production build, use a separate shell process so the fixture environment
cannot affect an interactive shell. The wrapper clears inherited application
configuration, sets a batch-only home and blocks dotenv loading before Next
reads it. It does not start the application or its background services.

```powershell
pnpm exec pwsh -NoProfile -File artifacts/batch-1/run-isolated.ps1 -Mode Build
```

## Browser journey

`ui-server.mjs` injects a stopped real Runtime into the production singleton
before Next instrumentation starts. Its `started` flag skips all background
startup, including model warmup, wake tasks and channel polling. Fixtures use
fresh files below `.batch-work/batch-1/coordinator/ui/`. Child processes and
remote fetches are blocked. It listens only on `127.0.0.1:17483` and never starts
a real runner. Do not replace this bootstrap with an ordinary Perry start.

```powershell
pnpm exec pwsh -NoProfile -File artifacts/batch-1/run-isolated.ps1 -Mode UI
```

Open the printed fixture URL in a temporary browser tab. The test key is
synthetic. `fixture.json` contains fresh IDs for the following repeatable steps:

1. The chat shows a reconnect warning and preserves the partial reply. Open the
   older failure's Details to inspect its synthetic detail.
2. POST `runner:checkIn` through `/api/backend/call`, with the fixture token and
   `activeTurnIds: [turnId, taskTurn]`. The warning clears; partial text remains.
3. POST `codex:finishTurn` with the token, turn ID, `errorCode: "idle_timeout"`
   and a synthetic error. POST internal `codex:finalizeTurn` to
   `/api/backend/admin`, with `x-perry-key: batch-ui-synthetic`. The trace is
   terminal, the partial reply remains, and per-turn recovery controls appear.
4. On Work → Plans, send an update to Fixture research. It shows Accepted and
   keeps the completed step. Query `tasks:steeringFromDashboard` with the fixture
   key/task ID; acknowledge its delivery using `codex:ackSteer` and `applied:true`.
   The visible receipt changes to Delivered into the running turn. The captured
   AX state and `ui-steering.json` confirm the transition; `steering.jpg` shows
   the earlier Accepted state. `steering-delivered.jpg` and its full AX snapshot capture the delivered state in a fresh reproduced fixture. `ui-plan.json` verifies one preserved receipt and
   the completed first step.
5. Close the temporary tab and stop only this fixture process. The recorded run
   did both. No installed Perry or real user configuration was accessed.

Observed desktop viewport: 924×764, no horizontal overflow, labeled input, and no
browser console warnings/errors. Screenshots: `warning.jpg`, `terminal.jpg`,
`steering.jpg`, and `steering-delivered.jpg`. This verifies the production UI and HTTP/backend transitions;
real CLI processes, user data migration, external channel delivery and mobile
breakpoints were not exercised.

An engine-acceptance/acknowledgement crash gap remains inherent in the steering
protocol: process-local outcome retention prevents transport retries from
duplicating work, but does not promise exactly-once model execution after a
process crash. See `docs/task-steering.md`.

## PR review follow-up

The pre-merge review added bounded verification of Finder metadata so a genuine
.DS_Store does not block startup; disguised or unknown data-bearing files remain
fail-closed. Setup restricts fresh/existing POSIX env-file modes; the existing
setup E2E now checks both paths in CI, while Windows retains inherited ACL
semantics. The Windows file-URL dotenv guard uses fileURLToPath. A retained
steering-map cleanup and unknown-label fallback also address two minor comments.

The steering access suggestion was verified and intentionally not applied:
claimTurn, live turnAccess and approval checks use the owner's current setting.
Steering cannot set access. Copying stale turn metadata would not impose a
permission cap and could misrepresent a later owner downgrade. Regression E2E
checks cover downgrade, later explicit upgrade, default Ask and rejected access
arguments (62 passing checks). Terminal trace repair on finalized legacy turns
is retained; skipping finalized rows would break repair. Broader recovery-query
index tuning is deferred rather than expanding this reliability change.

After these changes, the affected encryption/steering suites and the isolated
production build passed again. Other suite results and the original disposable
UI journey remain applicable; no real setup, services or installed app were run
locally for the review follow-up.
