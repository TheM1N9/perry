# Failure cases recorded before E2E source

- A task is queued/blocked/terminal, tracked-only, deleted, lacks its chat, or changes status while submission waits.
- Guest, task, job, missing, or another origin conversation tries to steer an owner's background task; wrong dashboard key; invalid task id.
- Paused Perry or a stopped/compacting/checkpoint/flush/guest turn accepts an instruction that unexpectedly runs later.
- Empty/oversize instructions or malformed/oversize request ids; receipt cap reached.
- Lost submission response/concurrent retry duplicates delivery; same request id with different text silently replaces it; retry after task finishes loses original receipt.
- No active turn between task turns: reject retryably without creating orphan runs or receipts.
- Engine cannot steer, refuses native steering, or finishes before acknowledgement: existing queueSteer fallback must deliver once, preserve original task progress/session/access, and not cancel anything.
- Wrong runner acknowledges, duplicate acknowledgement, delayed acknowledgement, server restart or reconnect changes delivery state incorrectly.
- Receipt says applied before engine acknowledges; queued fallback is described as applied; missing/pruned delivery is described as successful.
- Instruction overwrites plan, original prompt, turn counter, route, task status, or completed steps; subsequent set_plan hides accepted instruction history.
- A fallback turn starts without original task context on a fresh engine session, or later task/recovery turn forgets accepted instruction.
- A steer bypasses outside-content approval rules or expands access; runner's existing native/concurrent-prompt gate must remain unchanged.
- UI clears a failed draft or generates a new id after an ambiguous response; keyboard form lacks a label/status/error.

Integrated E2E must write compact result.json with same turn id before/after native steering, original completed step, engine events, and receipt/delivery states. No model APIs or real engine processes.

## Review fixes — cases recorded before extending E2E
- Engine accepts once; acknowledgement transport fails before commit: retry applied=true only, never replay engine or send applied=false.
- Acknowledgement commits but response is lost: retry same successful outcome idempotently.
- All bounded ack attempts fail: preserve process-local outcome, save finished engine result, withhold finishTurn; a later heartbeat retries acknowledgement without rerunning the engine.
- Concurrent subscription/finalization retries share one in-flight acknowledgement attempt and engine invocation.
- Engine refuses once; uncertain false acknowledgement is retried as false, creating exactly one fallback row.
- Original working turn errors while an accepted fallback is queued/running: task remains running, completed steps survive, no false failed report or extra work scheduler entry.
- Fallback is marked retrying before replacement exists: receipt shows queued/recovering and completion stays guarded.
- Retry chain has multiple hops or several run siblings: follow retryOf descendants within same run/chat; do not mistake unrelated turns for the accepted delivery.
- Retried accepted delivery completes/stops/fails: receipt and completion guard follow terminal replacement, not superseded original; replacement may finish its own task.
- Process crashes after engine acceptance before ack: process-local evidence can be lost; document this inherent protocol gap rather than claim exactly-once across crashes.

## PR297 access review — recorded before regression E2E extension
- Queued original turn records Full but owner downgrades chat to Ask before steering: update must snapshot Ask and both claims must use current Ask, never revive stale Full.
- Owner explicitly upgrades/downgrades chat after update is accepted: claimTurn and turnAccess must continue using live owner setting, not promise a nonexistent immutable permission cap.
- A running turn records an older permission level: native pendingSteers/engine.steer must not carry an access override; acceptance must not mutate chat or original turn access.
- Caller supplies an extra access=Full field to steering mutation: validator must reject it before run/receipt creation and leave owner access unchanged.
- Missing conversation access defaults to supervised even if the selected turn has stale Full metadata.
