# Updating a running background task

On Work → Plans, a running background task has an **Update instructions** form. Send a concise change and Perry keeps its completed work. In the owner chat that queued the task, Perry can forward an explicit owner update with `steer_task`. A blocked task still uses its existing answer/resume flow.

The instruction appears beside the task plan, separately from the agent's checklist. Replacing the checklist with `set_plan` does not remove owner updates. `status_report` also includes accepted update text, and later task/recovery turns receive those updates in order.

## Delivery

`tasks.steerFromDashboard` requires the dashboard key. `tasks.steer` is internal and requires the source conversation. A guest, task, job, missing chat, or a different origin chat cannot steer a scoped task. `steer_task` is excluded from guest tools and is an outward action under the existing outside-content approval rules.

The mutation validates a live background task and its own chat, creates a normal run, and calls the existing `codex.enqueueTurn` with `policy: "steer"`, the working turn's engine/model/instructions and the chat's current access. It does not cancel a turn, change task status/turn counts, or replace the task prompt/plan. Between working turns, or during stop/compaction/checkpoint, it refuses retryably instead of creating an orphan run. Paused Perry refuses new instructions.

When a working turn can be steered, the existing `codexSteers` row is delivered by the runner's `pendingSteers` subscription. Native or concurrent-prompt engines receive it through `engine.steer`; the runner acknowledges it with `ackSteer`. Other engines, refusals and finish-before-delivery use the existing `queueSteer` follow-up. An instruction accepted while the first task turn is still queued becomes a normal queued turn. Follow-ups contain the original brief, current checklist and owner update so a fresh engine session can continue the work.

`tasks.steering` contains receipts, not another delivery queue: request id, text, time and the existing delivery row id. `steeringFromDashboard` reads acknowledgement directly from `codexSteers` / its fallback `codexTurns`, following that turn's `retryOf` descendants through the existing run index. A refused turn waiting for an alternate engine remains queued; superseded failures do not hide a running or successfully finished replacement. The UI distinguishes accepted/pending, applied, queued, running, finished, failed, stopped and missing delivery records. An accepted instruction does not claim that the engine has acted on it or that the result is correct.

The shared `work.updateTask` integration checks `tasks.awaitingSteering` in the same transaction before done/blocked/failed. A prior turn cannot close the task before a queued accepted update runs; the current replacement's own `turnId` allows it to finish. While an accepted update is still pending or recovering, a prior turn's error finalization also keeps the task running instead of announcing a false failure. Cancellation remains the existing explicit stop path.

## Access follows the owner's live setting

Sending instructions does not change permissions. The steering API accepts no access argument and does not update chat access; native engine steering carries only the prompt, attachments and optional skills. The delivery row records the owner's current chat access, defaulting to supervised. It deliberately does not copy potentially stale `turn.access` metadata.

This matches ordinary turns: `codex.claimTurn` uses the conversation's access at claim time, `codex.turnAccess` reports live owner changes, and `approvals.request` reads that same conversation setting. The owner can explicitly change access after sending an update; steering does not create an immutable permission cap. Replacing the snapshot with `turn.access` would change metadata without imposing such a cap, and could record stale Full access after an owner downgrade.

## Retries and limits

Use a stable 8–100 character request id for each update (letters, digits, underscores and hyphens). Concurrent submissions or retries after a lost response return the original delivery id, including after the task finishes. Reusing an id with different text fails. The form retains its request id and draft after failure and disables duplicate submissions while sending. Each task accepts at most 40 updates, each 1–4000 characters; old receipts are never silently pruned to allow duplicate retries.

The runner keeps the engine's applied/refused outcome in its existing process-local steering map. An acknowledgement transport failure never becomes an engine refusal and never calls the engine again. Each acknowledgement batch makes at most three attempts with short backoffs; concurrent callers share the batch. If attempts fail, the finished engine result is saved and `finishTurn` is withheld. The existing heartbeat retries the retained acknowledgement and result independently of other turns. Successful finalization clears the process-local record. This uses the existing durable delivery rows and saved turn results, without a second queue or persisted delivery-state machine.

A process crash after the engine accepts a steer but before its acknowledgement commits can still leave ambiguous delivery: the in-memory engine outcome may be lost. This change does not claim exactly-once model execution across that protocol gap.

## Verification

Failure cases were recorded first in `artifacts/task-steering/failure-cases.md`. Run from the repository root:

```powershell
pnpm exec node --experimental-transform-types --import ./artifacts/secrets-at-rest/node-loader.mjs artifacts/task-steering/run.ts
```

The scenario creates a fresh SQLite runtime under `.batch-work/batch-1/281/e2e/run-*/`, with `PERRY_HOME` and a synthetic `DASHBOARD_KEY` set before project imports. It starts no scheduler, server, browser or real engine. A fake engine holds its original turn open while the real task/codex mutations and shared runner adapter deliver an update. The scenario checks the unchanged active turn and completed step, idempotent receipt, acknowledgement, fallback serialization, owner/guest boundaries, atomic finish guard and persistence, then writes a compact `result.json` with checks and evidence even on failure.

The final integrated run passed 51 checks, including failed/lost acknowledgement responses, bounded exhaustion and retained-outcome retry, original-turn error handling, and a production retryOn replacement. Final raw evidence, typecheck/build results and browser verification are in artifacts/batch-1/. This harness tests production backend and runner-adapter behavior with fake engines; it does not run a real CLI process.

The PR297 access-review extension passed 62 checks. It adds stale Full metadata after an owner downgrade, rejected permission overrides, explicit later owner upgrade/downgrade, default Ask and a production approval request still waiting under Ask. Follow-up evidence is `.batch-work/batch-1/281/e2e/run-1792180556004/result.json`; no new build or browser run was performed for this extension.
