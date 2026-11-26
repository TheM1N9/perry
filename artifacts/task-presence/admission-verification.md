# Task admission failure recovery

Verified on Windows on 2026-11-27 with the production schema, Store, Runtime, scheduler and application handlers. The existing task-presence journey now includes five admission scenarios. No engine, account, paid API or installed Perry data is used.

```shell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-presence/run.mjs node_modules/.cache/task-admission-fixed
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-presence/run.mjs node_modules/.cache/task-admission-baseline --admission-baseline
```

The initial fixed journey passed 35 cases. The baseline flag registers the unchanged admission handler directly as the scheduled `tasks:work` function, reproducing its previous single-mutation boundary without editing source. Its initial replay failed four admission assertions; the previous 30 task-presence cases and the cancellation/pause/dependency hold case passed. Running the new tests before the product change independently reproduced the first three failures.

Two real scheduled admissions hit a controlled SQLite trigger while creating their threads. Previously both tasks stayed `running`, two failed schedule records remained, no task outcomes were reported, and a third task stayed `queued` even after the next tick. With the wrapper, both tasks become `failed`, exactly one existing failure handoff is saved for each, no failed callback remains, and the next task takes a released slot. Repeated callbacks do not duplicate reports.

A second trigger rejects insertion of the `brain:handleTurn` schedule after partial admission. Runtime's existing nested-mutation savepoint rolls back the new thread, chat, run, turn and preparation schedule together. The wrapper then records the safe failure while preserving the original brief, plan and earlier result. A raw synthetic exception marker does not enter the owner-visible task error.

Separate cases retain an already-durable preparing turn and an accepted pending steer when another admission attempt faults. The existing turn and preparation schedule remain unchanged; no startup failure is reported and no replacement work is created. Successful initial admission creates exactly one preparing turn and one preparation schedule. Cancellation, the existing paused-question hold, and prerequisite waiting keep their prior behavior.

The scheduler replay stops synchronously when its two controlled attempts settle, before handoff or preparation actions can run. A guarded preparation boundary records any unexpected action attempt; all accepted runs recorded zero. Watchdogs and listeners are cleared, databases are closed, and each synthetic home was removed.

This prevents new startup failures from consuming task capacity indefinitely. It does not infer that historical running tasks without turns are safe to retry or fail: those rows do not carry an admission-attempt receipt proving whether older work ran. Their saved history and existing Board review state remain unchanged.

Automatic approval review rejected cleanup of the six fresh `node_modules/.cache/task-admission-*` report directories with `blocked by policy`. Their synthetic homes and runtime resources were removed normally; the small JSON reports remain. No alternate cleanup mechanism was attempted.

The coordinator repeated all 35 cases against the integrated candidate. Automatic review also blocked removing its `node_modules/.cache/integration-task-admission` report; the temporary home and runtime resources were removed normally.

## Reporting failure review follow-up

The extended journey passes 38 cases. Before the reporting fix, all three added cases failed: an originless admission failure rolled back when creating its reporting thread also failed; a saved completion rolled back for the same reason; and a persistent reporting error escaped the task transition. The final admission-only baseline now fails five cases, including the added originless admission case, while the reporting-only checks exercise the current reporting boundary.

After-turn notices now run in their own nested mutation. A reporting fault rolls back its reported fingerprint, destination and handoff writes together, while preserving the failed task or saved completion in the caller. One durable retry uses the existing scheduler. If that retry also fails, the native scheduler retains its failed callback and `scheduledFailures` record; the task stays non-running and no missing notice is marked reported. Nothing reruns the original task work.

Native cases clear the destination fault and replay the saved callback to prove exactly one handoff, retain the completion receipt and original checklist, and run an actual persistent-failure callback to verify durable failure recording. A newer error with the same timestamp also reproduced a stale-notice risk in the first fix. The callback now checks both the task state/timestamp and the exact current notice, so it cannot deliver that older error. Existing cancellation, pause, steering and admission checks still pass. The Runtime and temporary homes close normally.

```shell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-presence/run.mjs node_modules/.cache/task-report-final
```

Automatic approval review rejected cleanup of the new `node_modules/.cache/task-report-*` reports with `blocked by policy`. The synthetic homes, SQLite connections and fixture processes were removed normally; no alternative removal mechanism was attempted.
